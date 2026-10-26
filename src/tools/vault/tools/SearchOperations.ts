import { App, TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";
import { FindFilesParams, GrepVaultParams } from "../types";
import { FILESYSTEM_LIMITS } from "../constants";
import { countTextTokens } from "../../../utils/tokenCounting";
import { base64ToUtf8, utf8ToBase64 } from "../../../utils/base64";
import {
  createLineCalculator,
  wouldExceedCharLimit,
  validatePath,
  normalizeVaultPath,
  isHiddenSystemPath,
  listAdapterFiles,
  statAdapterPath,
  readAdapterText,
} from "../utils";
import {
  extractSearchTerms,
  calculateScore,
  sortByScore,
  formatScoredResults,
  FormattedScoredResults,
  ScoredResult,
} from "../searchScoring";
import SystemSculptPlugin from "../../../main";
import { searchVaultExclusions, VaultExclusions } from "../../../services/search/VaultExclusions";

type CompiledSearchPattern = Readonly<{
  raw: string;
  /** Stateless test of a path or title. */
  matcher: RegExp;
  /** Global scan and highlight; each synchronous use starts at lastIndex 0. */
  scanner: RegExp;
}>;
type FindMatch = { path: string; score: number; mtime: number | null };
type FindFilesResponse = {
  results: Array<{ path: string; score: number; modified?: string }>;
  totalFound: number;
  truncated?: boolean;
  notice?: string;
};
type GrepContext = {
  lines: number[];
  matchCount: number;
  context: string;
};
type GrepFileHit = {
  file: string;
  created: string;
  modified: string;
  totalMatches: number;
  contexts: GrepContext[];
  fileSize: number;
  pathMatchOnly?: boolean;
};
type SearchFile = TFile | { path: string; stat: { size: number; ctime: number; mtime: number } | null; __adapter: true };
type GrepQuery = Readonly<{
  patterns: string[];
  compiledPatterns: CompiledSearchPattern[];
  searchPaths: string[] | null;
  searchIn: "content" | "frontmatter" | "both";
  exclusions: VaultExclusions;
}>;
type GrepSnippet = Readonly<{ text: string; tokens: number }>;
/** One finished read of the vault for a query; later pages are slices of it. */
type GrepScan = Readonly<{
  id: string;
  /** The vault revision the scan started at. */
  revision: number;
  results: FormattedScoredResults;
  metaResults: unknown[];
  truncated: boolean;
  /** Every snippet, already in page order. */
  snippets: readonly GrepSnippet[];
}>;
type SearchCursor = Readonly<{ q: string; o: number; s?: string }>;

const MAX_SEARCH_SCOPE_PATHS = 64;
const MAX_SEARCH_SCOPE_PATH_LENGTH = 1024;
const WORD_CHARACTER = /\w/;
const FRONTMATTER_BLOCK = /^---\n([\s\S]*?)\n---/;
const LEADING_FRONTMATTER = /^---\n[\s\S]*?\n---\n/;
let grepScanSequence = 0;

function compileSearchPatterns(
  patterns: string[],
  mode: "literal" | "regex",
): CompiledSearchPattern[] {
  return patterns.map((raw) => {
    const source = mode === "regex"
      ? raw
      : raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try {
      return { raw, matcher: new RegExp(source, "i"), scanner: new RegExp(source, "gi") };
    } catch {
      throw new Error(`Invalid regex pattern: ${raw}`);
    }
  });
}

function titleOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const extension = name.lastIndexOf(".");
  return extension > 0 ? name.slice(0, extension) : name;
}

function encodeCursor(state: SearchCursor): string {
  try {
    return utf8ToBase64(JSON.stringify(state));
  } catch {
    return "";
  }
}

function decodeCursor(cursor?: string): SearchCursor | null {
  if (!cursor || typeof cursor !== 'string') return null;
  try {
    const decoded: unknown = JSON.parse(base64ToUtf8(cursor));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
    const candidate = decoded as Record<string, unknown>;
    if (typeof candidate.q !== "string" || typeof candidate.o !== "number") return null;
    return typeof candidate.s === "string"
      ? { q: candidate.q, o: candidate.o, s: candidate.s }
      : { q: candidate.q, o: candidate.o };
  } catch {
    return null;
  }
}

/**
 * Search operations for first-party vault tools.
 */
export class SearchOperations {
  /** Advances on every vault change a search could see. */
  private vaultRevision = 0;
  private vaultWatched = false;
  /** Scans with a page still to serve, by query, until the vault changes. */
  private readonly grepScans = new Map<string, GrepScan>();

  constructor(
    private app: App,
    private allowedPaths: string[],
    private plugin: SystemSculptPlugin
  ) {
    // Simplified - no complex search engine needed
  }

  /**
   * Forget kept scans when a searchable file is created, edited, deleted or
   * renamed, so a later page never shows text the vault no longer has.
   * Excluded files, chat transcripts by default, cannot change a result, so
   * saving the running chat keeps its scans.
   */
  private watchVault(): void {
    if (this.vaultWatched) return;
    this.vaultWatched = true;
    const onChange = (file: TAbstractFile, oldPath?: string) => {
      const exclusions = searchVaultExclusions(this.plugin);
      const searchable = (path: string | undefined) =>
        typeof path === "string" && !exclusions.isExcluded(path);
      if (!searchable(file.path) && !searchable(oldPath)) return;
      this.vaultRevision++;
      this.grepScans.clear();
    };
    this.plugin.registerEvent(this.app.vault.on("create", onChange));
    this.plugin.registerEvent(this.app.vault.on("modify", onChange));
    this.plugin.registerEvent(this.app.vault.on("delete", onChange));
    this.plugin.registerEvent(this.app.vault.on("rename", onChange));
  }

  private isAllowedPath(path: string): boolean {
    return validatePath(path, this.allowedPaths);
  }

  private shouldDescend(path: string): boolean {
    const normalized = normalizePath(path);
    if (this.allowedPaths.some((allowed) => normalizePath(allowed) === "/")) {
      return true;
    }
    if (!normalized || normalized === "/") {
      return true;
    }
    return this.allowedPaths.some((allowed) => {
      const allowedNormalized = normalizePath(allowed);
      if (allowedNormalized === "/") return true;
      return allowedNormalized === normalized || allowedNormalized.startsWith(`${normalized}/`);
    });
  }

  private normalizeStringArray(input: unknown): string[] {
    if (!Array.isArray(input)) return [];
    return (input as unknown[])
      .map((v) => (typeof v === "string" ? v : String(v ?? "")))
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  private normalizeSearchPaths(input: unknown): string[] | null {
    if (input === undefined || input === null) return null;
    if (!Array.isArray(input) || input.length === 0) {
      throw new Error(
        "Search 'paths' must be a non-empty array of vault-relative file or folder paths.",
      );
    }
    if (input.length > MAX_SEARCH_SCOPE_PATHS) {
      throw new Error(
        `Search 'paths' supports at most ${MAX_SEARCH_SCOPE_PATHS} entries.`,
      );
    }

    const normalized = new Set<string>();
    for (const value of input) {
      if (typeof value !== "string") {
        throw new Error("Every search path must be a string.");
      }
      if (value.length > MAX_SEARCH_SCOPE_PATH_LENGTH) {
        throw new Error(
          `Search paths must be no longer than ${MAX_SEARCH_SCOPE_PATH_LENGTH} characters.`,
        );
      }
      const trimmed = value.trim();
      if (trimmed.length === 0 && value.length > 0) {
        throw new Error("Search paths cannot contain only whitespace.");
      }
      const vaultPath = normalizeVaultPath(trimmed);
      if (vaultPath.split("/").some((segment) => segment === "..")) {
        throw new Error("Search paths must stay within the vault.");
      }
      const canonical = vaultPath === "." || vaultPath.length === 0
        ? ""
        : normalizePath(vaultPath).replace(/^\/+|\/+$/g, "");
      normalized.add(canonical);
    }

    // A root scope already contains every other requested path.
    if (normalized.has("")) return [""];
    return [...normalized].sort();
  }

  private isWithinSearchPaths(path: string, searchPaths: string[] | null): boolean {
    if (searchPaths === null) return true;
    const normalizedPath = normalizePath(normalizeVaultPath(path));
    return searchPaths.some((scope) =>
      scope.length === 0
      || normalizedPath === scope
      || normalizedPath.startsWith(`${scope}/`));
  }

  private getHiddenAllowedPaths(): string[] {
    return this.allowedPaths
      .map((path) => normalizePath(String(path ?? "")).replace(/^\/+/, ""))
      .filter((path) => path.length > 0 && isHiddenSystemPath(path));
  }

  private async listHiddenFiles(): Promise<Array<{ path: string; stat: { size: number; ctime: number; mtime: number } | null; __adapter: true }>> {
    const hiddenRoots = this.getHiddenAllowedPaths();
    if (hiddenRoots.length === 0) return [];
    const adapter = this.app.vault.adapter;

    const seen = new Set<string>();
    const results: Array<{ path: string; stat: { size: number; ctime: number; mtime: number } | null; __adapter: true }> = [];
    for (const root of hiddenRoots) {
      let files: string[] = [];
      try {
        files = await listAdapterFiles(adapter, root);
      } catch {
        files = [];
      }
      for (const filePath of files) {
        const normalized = normalizePath(filePath);
        if (!this.isAllowedPath(normalized)) continue;
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        let stat: { size: number; ctime: number; mtime: number } | null = null;
        try {
          stat = await statAdapterPath(adapter, normalized);
        } catch {
          stat = null;
        }
        results.push({ path: normalized, stat, __adapter: true });
      }
    }
    return results;
  }

  /**
   * Find files and folders whose names match at least one search term.
   */
  async findFiles(params: FindFilesParams): Promise<unknown> {
    const patterns = this.normalizeStringArray(params.patterns);
    if (patterns.length === 0) {
      throw new Error("Missing required 'patterns'. Provide one or more search terms, e.g., [\"systemsculpt\", \"API_TOKEN\"].");
    }
    const globalResultLimit = FILESYSTEM_LIMITS.MAX_SEARCH_RESULTS * 3;
    const requestedMaxResults = params.maxResults;
    if (
      requestedMaxResults !== undefined
      && requestedMaxResults !== null
      && (!Number.isSafeInteger(requestedMaxResults) || requestedMaxResults < 1)
    ) {
      throw new Error("maxResults must be a positive integer.");
    }
    const resultLimit = Math.min(
      requestedMaxResults ?? globalResultLimit,
      globalResultLimit,
    );
    
    // Extract search terms from patterns
    const originalQuery = patterns.join(' ');
    const searchTerms = extractSearchTerms(originalQuery);
    
    const matches: FindMatch[] = [];
    const seenPaths = new Set<string>();
    const consider = (path: string, mtime: number | null | undefined) => {
      const scored = calculateScore(path, '', {
        searchTerms,
        originalQuery
      });
      // A name that contains no search term is not a result, however it scores.
      if (scored.matchDetails.keywordsFound.length === 0) return;
      matches.push({
        path: scored.path,
        score: scored.score,
        mtime: typeof mtime === "number" && Number.isFinite(mtime) && mtime > 0 ? mtime : null,
      });
    };

    const adapterFiles = await this.listHiddenFiles();
    
    // Search files
    const files = this.app.vault.getFiles();
    const exclusions = searchVaultExclusions(this.plugin);
    for (const file of files) {
      // Exclude chat history and system files
      if (exclusions.isExcluded(file.path)) {
        continue;
      }
      if (!this.isAllowedPath(file.path)) {
        continue;
      }
      if (seenPaths.has(file.path)) {
        continue;
      }
      seenPaths.add(file.path);
      consider(file.path, file.stat?.mtime);
    }

    for (const file of adapterFiles) {
      if (seenPaths.has(file.path)) {
        continue;
      }
      seenPaths.add(file.path);
      consider(file.path, file.stat?.mtime);
    }
    
    // Search folders
    const searchFolder = (folder: TFolder) => {
      if (!this.shouldDescend(folder.path)) {
        return;
      }
      for (const child of folder.children) {
        if (child instanceof TFolder) {
          // An excluded folder hides its whole subtree of folders.
          if (exclusions.isFolderExcluded(child.path)) continue;
          if (this.isAllowedPath(child.path)) {
            consider(child.path, null);
          }
          // Recursively search subfolders
          searchFolder(child);
        }
      }
    };
    
    const rootFolder = this.app.vault.getRoot();
    searchFolder(rootFolder);

    const adapterFolders = new Set<string>();
    for (const file of adapterFiles) {
      const parts = file.path.split("/").filter((part) => part.length > 0);
      for (let i = 1; i < parts.length; i++) {
        const folderPath = parts.slice(0, i).join("/");
        if (!this.isAllowedPath(folderPath)) continue;
        adapterFolders.add(folderPath);
      }
    }

    for (const folderPath of adapterFolders) {
      if (seenPaths.has(folderPath)) {
        continue;
      }
      seenPaths.add(folderPath);
      consider(folderPath, null);
    }
    
    // Rank, then return only what the caller needs to open or list a match.
    matches.sort((left, right) => right.score - left.score);
    const response: FindFilesResponse = {
      results: matches.slice(0, resultLimit).map(({ path, score, mtime }) => ({
        path,
        score,
        ...(mtime === null ? {} : { modified: new Date(mtime).toISOString() }),
      })),
      totalFound: matches.length,
    };
    if (matches.length === 0) {
      response.notice = `No file or folder names contain ${patterns.map((pattern) => `"${pattern}"`).join(", ")}. `
        + "Patterns are plain name fragments, not globs or regexes. Try a shorter fragment, or use search to look inside note contents.";
    }
    while (
      response.results.length > 0
      && JSON.stringify(response).length > FILESYSTEM_LIMITS.MAX_RESPONSE_CHARS
    ) {
      response.results.pop();
      response.truncated = true;
    }
    return response;
  }

  /**
   * Search within note contents using one or more search terms (regex supported) - with intelligent scoring.
   * Pages after the first come from the kept scan and read no file.
   */
  async grepVault(params: GrepVaultParams): Promise<unknown> {
    const patterns = this.normalizeStringArray(params.patterns);
    const searchPaths = this.normalizeSearchPaths(params.paths);
    const searchIn = params.searchIn ?? 'content';
    const requestedPatternMode = params.patternMode;
    if (requestedPatternMode != null && requestedPatternMode !== "literal" && requestedPatternMode !== "regex") {
      throw new Error("patternMode must be either 'literal' or 'regex'.");
    }
    const patternMode: "literal" | "regex" = requestedPatternMode ?? "literal";
    const requestedCursor = params.cursor;
    if (requestedCursor != null && (typeof requestedCursor !== "string" || requestedCursor.length > 4096)) {
      throw new Error("Search cursor must be a string no longer than 4096 characters.");
    }
    const requestedPageTokens = Math.max(512, Math.min(4096, Number(params.pageTokens || FILESYSTEM_LIMITS.MAX_TOOL_RESULT_TOKENS)));
    const bodyTokenBudget = Math.max(256, requestedPageTokens - FILESYSTEM_LIMITS.GREP_FOOTER_TOKENS);
    if (patterns.length === 0) {
      throw new Error("Missing required 'patterns'. Add one or more words or regex patterns, e.g., [\"systemsculpt\", \"api key\"].");
    }
    const compiledPatterns = compileSearchPatterns(patterns, patternMode);

    const qId = `${searchIn}|${patternMode}|${patterns.join('\u0001')}${
      searchPaths === null ? "" : `|paths:${searchPaths.join("\u0001")}`
    }`;
    const rawCursor = requestedCursor;
    const cursorState = decodeCursor(rawCursor ?? undefined);
    if (rawCursor && (!cursorState || cursorState.q !== qId || !Number.isFinite(cursorState.o))) {
      throw new Error("Invalid search cursor for this query.");
    }

    this.watchVault();
    const exclusions = searchVaultExclusions(this.plugin);
    const scanKey = `${qId}\u0000${exclusions.signature}`;
    const scan = this.grepScans.get(scanKey) ?? await this.scanContents({
      patterns,
      compiledPatterns,
      searchPaths,
      searchIn,
      exclusions,
    });
    const snippets = scan.snippets;
    const startOffset = cursorState ? Math.max(0, Math.min(snippets.length, cursorState.o)) : 0;

    let usedTokens = 0;
    let end = startOffset;
    while (end < snippets.length && usedTokens + snippets[end].tokens <= bodyTokenBudget) {
      usedTokens += snippets[end].tokens;
      end++;
    }

    // Each response trims its own copy; the kept scan serves every page.
    const MAX_CHARS = FILESYSTEM_LIMITS.MAX_RESPONSE_CHARS;
    const formattedResults: FormattedScoredResults = { ...scan.results, results: [...scan.results.results] };
    const metaResults = cursorState !== null && cursorState.s !== scan.id
      ? [...scan.metaResults, {
        file: "_new_search",
        notice: "The search behind this cursor was no longer kept, so this page comes from a new search. Some matches may repeat or be missing; search again without a cursor for a fresh list.",
        totalMatches: 0,
        contexts: []
      }]
      : scan.metaResults;
    if (metaResults.length > 0) formattedResults.metaInfo = metaResults;
    if (scan.truncated) {
      formattedResults.truncated = true;
      formattedResults.notice = `Results were truncated to stay within the ${MAX_CHARS} character response cap.`;
    }

    const buildResponse = () => {
      const remainingCount = snippets.length - end;
      let omittedTokens = 0;
      for (let j = end; j < snippets.length; j++) {
        omittedTokens += snippets[j].tokens;
      }
      return {
        ...formattedResults,
        ...(searchPaths === null
          ? {}
          : { scope: { paths: searchPaths.map((path) => path || ".") } }),
        page: {
          tokensBudget: requestedPageTokens,
          tokensUsed: usedTokens,
          bodyTokenBudget,
          next_cursor: end < snippets.length ? encodeCursor({ q: qId, o: end, s: scan.id }) : null,
          total_matches: snippets.length,
          returned_matches: end - startOffset,
          omitted_matches: remainingCount,
          omitted_tokens: omittedTokens
        },
        snippets: snippets.slice(startOffset, end).map((snippet) => snippet.text),
        footer: remainingCount > 0 ? `...[omitted ${omittedTokens} tokens across ${remainingCount} matches]` : ''
      };
    };

    let response = buildResponse();
    while (end > startOffset && JSON.stringify(response).length > MAX_CHARS) {
      end -= 1;
      usedTokens -= snippets[end].tokens;
      response = buildResponse();
    }
    while (formattedResults.results.length > 0 && JSON.stringify(response).length > MAX_CHARS) {
      formattedResults.results.pop();
      formattedResults.truncated = true;
      response = buildResponse();
    }
    // Keep the scan only while a cursor can still reach it, and never one the
    // vault changed under while it ran.
    if (response.page.next_cursor !== null && scan.revision === this.vaultRevision) {
      this.grepScans.set(scanKey, scan);
    }
    return response;
  }

  /**
   * Read the scoped vault once for a query. Files whose title, then path,
   * matches come first, then the most recently modified, so a large active
   * note is read before the result and time budgets run out. Hits keep that
   * order, so an unchanged vault always gives the same pages.
   */
  private async scanContents(query: GrepQuery): Promise<GrepScan> {
    const { patterns, compiledPatterns, searchPaths, searchIn, exclusions } = query;
    const revision = this.vaultRevision;

    // Extract search terms for intelligent scoring
    const originalQuery = patterns.join(' ');
    const searchTerms = extractSearchTerms(originalQuery);
    // We keep two buckets: fileHits (actual matches) and metaResults (info, timeout, etc.)
    // Meta entries carry their text under `notice`: the outbound tool-result
    // sanitizer rewrites any `message` string as a failure.
    const metaResults: unknown[] = [];
    const fileHits: GrepFileHit[] = [];

    // Track serialized response size to ensure we never exceed the model-safe
    // limit.
    const MAX_CHARS = FILESYSTEM_LIMITS.MAX_RESPONSE_CHARS;
    let currentSize = 0;
    let truncated = false;

    // Performance configuration constants
    const CONTEXT_CHARS = FILESYSTEM_LIMITS.CONTEXT_CHARS;
    const BATCH_SIZE = FILESYSTEM_LIMITS.BATCH_SIZE;
    const MAX_PROCESSING_TIME = FILESYSTEM_LIMITS.MAX_PROCESSING_TIME;
    const MAX_FILE_SIZE = FILESYSTEM_LIMITS.MAX_FILE_SIZE;
    const MAX_MATCHES_PER_FILE = FILESYSTEM_LIMITS.MAX_MATCHES_PER_FILE;

    // Performance metrics
    const metrics = {
      filesProcessed: 0,
      filesSkipped: 0,
      totalMatches: 0,
      processingTime: 0,
      largestFile: 0,
      timeouts: 0
    };

    const startTime = Date.now();
    const adapter = this.app.vault.adapter;

    const isAdapterFile = (file: SearchFile): file is { path: string; stat: { size: number; ctime: number; mtime: number } | null; __adapter: true } =>
      !(file instanceof TFile);
    const getStat = (file: SearchFile) => (isAdapterFile(file) ? file.stat : file.stat);

    let filesToSearch: SearchFile[] = this.app.vault.getFiles();
    const adapterFiles = await this.listHiddenFiles();
    if (adapterFiles.length > 0) {
      filesToSearch = filesToSearch.concat(adapterFiles);
    }

    // Exclude chat history and system files
    filesToSearch = filesToSearch.filter((file) => {
      if (!this.isAllowedPath(file.path)) return false;
      if (!this.isWithinSearchPaths(file.path, searchPaths)) return false;
      if (isAdapterFile(file)) return true;
      return !exclusions.isExcluded(file.path);
    });

    // Rank before reading: a title hit, then a path hit, then recency. Size
    // plays no part, so common terms no longer fill the result budget with
    // small notes before a large one is opened. Path order breaks ties.
    const matchesAny = (text: string) => compiledPatterns.some((pattern) => pattern.matcher.test(text));
    const candidates = filesToSearch.map((file) => {
      const pathHit = matchesAny(file.path);
      return {
        file,
        pathHit,
        rank: pathHit ? (matchesAny(titleOf(file.path)) ? 2 : 1) : 0,
        mtime: getStat(file)?.mtime ?? 0,
      };
    });
    candidates.sort((a, b) =>
      b.rank - a.rank
      || b.mtime - a.mtime
      || (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0));

    // Read one candidate. A file whose path matches is a hit even when its
    // text does not; when both match it is still one hit.
    const scanFile = async ({ file, pathHit }: (typeof candidates)[number]): Promise<GrepFileHit | null> => {
      // Check processing time limit
      if (Date.now() - startTime > MAX_PROCESSING_TIME) {
        metrics.timeouts++;
        return null;
      }

      // Check file size limit
      const stat = getStat(file);
      const fileSize = stat?.size ?? 0;
      if (fileSize > MAX_FILE_SIZE) {
        metrics.filesSkipped++;
        return null;
      }

      // Track largest file processed
      if (fileSize > metrics.largestFile) {
        metrics.largestFile = fileSize;
      }

      const created = stat?.ctime ? new Date(stat.ctime).toISOString() : new Date().toISOString();
      const modified = stat?.mtime ? new Date(stat.mtime).toISOString() : new Date().toISOString();
      const pathOnlyHit: GrepFileHit | null = pathHit
        ? { file: file.path, created, modified, totalMatches: 0, contexts: [], fileSize, pathMatchOnly: true }
        : null;

      try {
        const fullContent = isAdapterFile(file)
          ? await readAdapterText(adapter, file.path)
          : await this.app.vault.cachedRead(file);
        metrics.filesProcessed++;

        // Skip empty files
        if (!fullContent || fullContent.length === 0) {
          return pathOnlyHit;
        }

        // Determine what content to search based on searchIn parameter
        let content = fullContent;
        let contentOffset = 0; // Track offset for line number calculation

        if (searchIn === 'frontmatter' || searchIn === 'both') {
          // Extract frontmatter
          const frontmatterMatch = FRONTMATTER_BLOCK.exec(fullContent);
          if (frontmatterMatch) {
            if (searchIn === 'frontmatter') {
              // Search only frontmatter
              content = frontmatterMatch[0];
            }
            // For 'both', we search the full content
          } else if (searchIn === 'frontmatter') {
            // No frontmatter and we're only searching frontmatter
            return pathOnlyHit;
          }
        } else if (searchIn === 'content') {
          // Skip frontmatter for content-only search
          const frontmatterMatch = LEADING_FRONTMATTER.exec(fullContent);
          if (frontmatterMatch) {
            content = fullContent.substring(frontmatterMatch[0].length);
            contentOffset = frontmatterMatch[0].length;
          }
        }

        const getLineNumber = createLineCalculator(fullContent);

        // Collect matches from all patterns with early exit. The loop never
        // awaits, so concurrent files can share each pattern's scanner.
        const allMatches: Array<{index: number, text: string, line: number, pattern: string}> = [];

        for (const pattern of compiledPatterns) {
          const regex = pattern.scanner;
          regex.lastIndex = 0;
          let match;

          while ((match = regex.exec(content)) !== null && allMatches.length < MAX_MATCHES_PER_FILE) {
            const lineNumber = getLineNumber(match.index + contentOffset);
            allMatches.push({
              index: match.index + contentOffset,
              text: match[0],
              line: lineNumber,
              pattern: pattern.raw
            });
            metrics.totalMatches++;
            if (match[0].length === 0) {
              regex.lastIndex += 1;
            }
          }

          // Reset regex lastIndex for next pattern
          regex.lastIndex = 0;

          if (allMatches.length >= MAX_MATCHES_PER_FILE) break;
        }

        if (allMatches.length === 0) {
          return pathOnlyHit;
        }

        // Merge overlapping contexts efficiently
        const contextWindows: Array<{
          start: number,
          end: number,
          lines: number[],
          matchCount: number
        }> = [];

        for (const matchInfo of allMatches) {
          const matchStart = matchInfo.index;
          const matchEnd = matchStart + matchInfo.text.length;

          // Calculate context boundaries
          let contextStart = Math.max(0, matchStart - CONTEXT_CHARS);
          let contextEnd = Math.min(content.length, matchEnd + CONTEXT_CHARS);

          // Optimize word boundary adjustment (limit iterations)
          let adjustments = 0;
          while (contextStart > 0 && WORD_CHARACTER.test(content[contextStart - 1]) && adjustments < 50) {
            contextStart--;
            adjustments++;
          }
          adjustments = 0;
          while (contextEnd < content.length && WORD_CHARACTER.test(content[contextEnd]) && adjustments < 50) {
            contextEnd++;
            adjustments++;
          }

          // Check if this overlaps with any existing window (optimized)
          let merged = false;
          for (let i = 0; i < contextWindows.length; i++) {
            const window = contextWindows[i];
            if (contextStart <= window.end && contextEnd >= window.start) {
              // Merge windows
              window.start = Math.min(window.start, contextStart);
              window.end = Math.max(window.end, contextEnd);
              window.lines.push(matchInfo.line);
              window.matchCount++;
              merged = true;
              break;
            }
          }

          if (!merged) {
            contextWindows.push({
              start: contextStart,
              end: contextEnd,
              lines: [matchInfo.line],
              matchCount: 1
            });
          }
        }

        // Create results from merged windows
        const contexts = contextWindows.map(window => {
          let contextStr = content.substring(window.start, window.end);

          // Replace all matches in context with highlighted version for each pattern
          for (const pattern of compiledPatterns) {
            contextStr = contextStr.replace(pattern.scanner, '【$&】');
          }

          // Add ellipsis if truncated
          if (window.start > 0) contextStr = '...' + contextStr;
          if (window.end < content.length) contextStr = contextStr + '...';

          return {
            lines: window.lines,
            matchCount: window.matchCount,
            context: contextStr
          };
        });

        return {
          file: file.path,
          created,
          modified,
          totalMatches: allMatches.length,
          contexts,
          fileSize // used for ranking
        };
      } catch {
        metrics.filesSkipped++;
        // Silently skip problematic files
        return pathOnlyHit;
      }
    };

    // Process files in batches with yielding
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      // Check timeout before each batch
      if (Date.now() - startTime > MAX_PROCESSING_TIME) {
        metaResults.push({
          file: "_timeout",
          notice: `Search timed out after ${MAX_PROCESSING_TIME / 1000} seconds to prevent UI freeze. Found ${fileHits.length} results. Use more specific search terms or paths.`,
          totalMatches: metrics.totalMatches,
          contexts: []
        });
        break;
      }

      // Check if we have enough results
      if (fileHits.length >= FILESYSTEM_LIMITS.MAX_SEARCH_RESULTS) {
        metaResults.push({
          file: "_summary",
          notice: `Search stopped after ${FILESYSTEM_LIMITS.MAX_SEARCH_RESULTS} files with matches. More results may exist.`,
          totalMatches: metrics.totalMatches,
          contexts: []
        });
        break;
      }

      // Read a batch at once, then take its hits in candidate order
      const batchHits = await Promise.all(candidates.slice(i, i + BATCH_SIZE).map(scanFile));
      for (const hit of batchHits) {
        if (!hit || fileHits.length >= FILESYSTEM_LIMITS.MAX_SEARCH_RESULTS) continue;
        if (wouldExceedCharLimit(currentSize, hit, MAX_CHARS)) {
          truncated = true;
          continue;
        }
        fileHits.push(hit);
        currentSize += JSON.stringify(hit).length;
      }

      // Yield control to prevent UI freeze (critical for performance)
      await new Promise(resolve => window.setTimeout(resolve, 0));
    }

    // Add performance summary if processing took significant time or had issues
    metrics.processingTime = Date.now() - startTime;

    if (metrics.processingTime > 2000 || metrics.filesSkipped > 10 || metrics.timeouts > 0) {
      metaResults.push({
        file: "_performance",
        notice: `Search completed in ${metrics.processingTime}ms. Processed: ${metrics.filesProcessed} files, Skipped: ${metrics.filesSkipped} files, Total matches: ${metrics.totalMatches}. Largest file: ${Math.round(metrics.largestFile / 1024)}KB.`,
        totalMatches: metrics.totalMatches,
        contexts: []
      });
    }

    // If we failed to find any matches at all, provide a concise but helpful
    // no-result summary so the user understands why nothing useful came
    // back and what they can try next.
    if (fileHits.length === 0) {
      const scopeDescription = searchPaths === null
        ? ""
        : ` within ${searchPaths.map((path) => path || "the vault root").join(", ")}`;
      metaResults.push({
        file: "_no_matches",
        notice: `No matches found${scopeDescription} for: ${patterns.map(p => `"${p}"`).join(", ")}. Try different words, adjust where you search (text vs. properties), or change the requested paths.`,
        totalMatches: 0,
        contexts: []
      });
    }

    /* -------------------- Intelligent Scoring & Sorting -------------------- */

    // Convert fileHits to ScoredResults with intelligent scoring
    const scoredResults: ScoredResult[] = [];

    for (const hit of fileHits) {
      // Read a snippet of content for scoring (if not already loaded)
      let contentSnippet = '';
      if (hit.contexts && hit.contexts.length > 0) {
        contentSnippet = hit.contexts.map((context) => context.context).join(' ');
      }

      // Calculate intelligent score
      const scoreResult = calculateScore(hit.file, contentSnippet, {
        searchTerms,
        originalQuery
      });

      // Preserve original metadata and contexts
      scoreResult.created = hit.created;
      scoreResult.modified = hit.modified;
      scoreResult.fileSize = hit.fileSize;
      scoreResult.contexts = hit.contexts;

      // Add match-specific bonus to score
      if (hit.totalMatches > 0) {
        const matchBonus = Math.min(20, hit.totalMatches * 2); // Up to 20 points for multiple matches
        scoreResult.score = Math.min(100, scoreResult.score + matchBonus);
        scoreResult.matchDetails.reasoning += `, ${hit.totalMatches} content matches (+${matchBonus})`;
      }

      scoredResults.push(scoreResult);
    }

    // Sort by score and format results
    const now = Date.now();
    for (const r of scoredResults) {
      if (r.modified) {
        const days = Math.max(0, (now - new Date(r.modified).getTime()) / 86400000);
        const recencyBonus = Math.max(0, Math.min(20, Math.round(20 * (30 / (30 + days)))));
        r.score = Math.min(100, r.score + recencyBonus);
      }
    }
    const sortedResults = sortByScore(scoredResults);

    const makeSnippets = (): GrepSnippet[] => {
      const snippets: GrepSnippet[] = [];
      const seen = new Set<string>();
      for (const r of sortedResults) {
        const ctxs = (r.contexts || []) as Array<{ lines: number[]; context: string; matchCount: number }>;
        for (const c of ctxs) {
          const line = Array.isArray(c.lines) && c.lines.length > 0 ? Math.min(...c.lines) : 1;
          const text = `${r.path}:${line}  ${c.context}`;
          const key = `${r.path}|${line}|${c.context}`;
          if (seen.has(key)) continue;
          seen.add(key);
          snippets.push({ text, tokens: countTextTokens(text) });
        }
      }
      return snippets;
    };

    // Page order: the best 30%, then the last 30%, then the middle.
    const buildOrder = (n: number): number[] => {
      const head = Math.ceil(n * 0.3);
      const tail = Math.ceil(n * 0.3);
      const order: number[] = [];
      for (let i = 0; i < Math.min(head, n); i++) order.push(i);
      for (let i = Math.max(n - tail, head); i < n; i++) order.push(i);
      for (let i = head; i < Math.max(n - tail, head); i++) order.push(i);
      return order;
    };

    const allSnippets = makeSnippets();
    const results = formatScoredResults(sortedResults, FILESYSTEM_LIMITS.MAX_SEARCH_RESULTS);
    if (Array.isArray(results.results)) {
      for (const result of results.results) delete result.contexts;
    }
    return {
      id: `${startTime.toString(36)}.${(++grepScanSequence).toString(36)}`,
      revision,
      results,
      metaResults,
      truncated,
      snippets: buildOrder(allSnippets.length).map((index) => allSnippets[index]),
    };
  }

}
