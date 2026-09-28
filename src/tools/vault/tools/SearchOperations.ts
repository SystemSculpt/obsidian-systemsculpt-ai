import { App, TFile, TFolder, normalizePath } from "obsidian";
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
import { extractSearchTerms, calculateScore, sortByScore, formatScoredResults, ScoredResult } from "../searchScoring";
import SystemSculptPlugin from "../../../main";
import { searchVaultExclusions } from "../../../services/search/VaultExclusions";

type CompiledSearchPattern = Readonly<{ raw: string; source: string }>;
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
const MAX_SEARCH_SCOPE_PATHS = 64;
const MAX_SEARCH_SCOPE_PATH_LENGTH = 1024;

function compileSearchPatterns(
  patterns: string[],
  mode: "literal" | "regex",
): CompiledSearchPattern[] {
  return patterns.map((raw) => {
    const source = mode === "regex"
      ? raw
      : raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try {
      void new RegExp(source, "i");
    } catch {
      throw new Error(`Invalid regex pattern: ${raw}`);
    }
    return { raw, source };
  });
}

/**
 * Search operations for first-party vault tools.
 */
export class SearchOperations {
  constructor(
    private app: App,
    private allowedPaths: string[],
    private plugin: SystemSculptPlugin
  ) {
    // Simplified - no complex search engine needed
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
   * Search within note contents using one or more search terms (regex supported) - with intelligent scoring
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
    
    // Extract search terms for intelligent scoring
    const originalQuery = patterns.join(' ');
    const searchTerms = extractSearchTerms(originalQuery);
    // We keep two buckets: fileHits (actual matches) and metaResults (info, timeout, etc.)
    // Meta entries carry their text under `notice`: the outbound tool-result
    // sanitizer rewrites any `message` string as a failure.
    const metaResults: unknown[] = [];
    const fileHits: GrepFileHit[] = [];
    
    // Track serialized response size to ensure we never exceed the model-safe
    // limit. These counters are shared across the entire search operation so
    // that even deeply nested helper functions can reference them.
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

    type SearchFile = TFile | { path: string; stat: { size: number; ctime: number; mtime: number } | null; __adapter: true };
    const isAdapterFile = (file: SearchFile): file is { path: string; stat: { size: number; ctime: number; mtime: number } | null; __adapter: true } =>
      !(file instanceof TFile);
    const getStat = (file: SearchFile) => (isAdapterFile(file) ? file.stat : file.stat);
    const getSize = (file: SearchFile) => getStat(file)?.size ?? 0;
    
    // Search entire vault using cached access if available
    const getFiles = () => {
      try {
        return this.plugin.vaultFileCache?.getAllFiles() || this.app.vault.getFiles();
      } catch {
        return [];
      }
    };
    
    let filesToSearch: SearchFile[] = getFiles();
    const adapterFiles = await this.listHiddenFiles();
    if (adapterFiles.length > 0) {
      filesToSearch = filesToSearch.concat(adapterFiles);
    }

    // Exclude chat history and system files
    const exclusions = searchVaultExclusions(this.plugin);
    filesToSearch = filesToSearch.filter((file) => {
      if (!this.isAllowedPath(file.path)) return false;
      if (!this.isWithinSearchPaths(file.path, searchPaths)) return false;
      if (isAdapterFile(file)) return true;
      return !exclusions.isExcluded(file.path);
    });

    // Sort files by size (smallest first) so we surface results quickly from
    // lightweight notes. We intentionally *do not* truncate the list at this
    // stage; instead the outer batching / timeout logic will stop the search
    // once either MAX_PROCESSING_TIME is exceeded or we have gathered enough
    // results. This guarantees that we always try to return at least some
    // real matches, even in gigantic vaults.
    filesToSearch.sort((a, b) => getSize(a) - getSize(b));
    
    let resultsCount = 0;
    
    // Helper function to process a single file
    const processFile = async (file: SearchFile): Promise<void> => {
      // Early exit conditions
      if (resultsCount >= FILESYSTEM_LIMITS.MAX_SEARCH_RESULTS) {
        return;
      }
      
      // Check processing time limit
      if (Date.now() - startTime > MAX_PROCESSING_TIME) {
        metrics.timeouts++;
        return;
      }
      
      // Check file size limit
      const stat = getStat(file);
      const fileSize = stat?.size ?? 0;
      if (fileSize > MAX_FILE_SIZE) {
        metrics.filesSkipped++;
        return;
      }
      
      // Track largest file processed
      if (fileSize > metrics.largestFile) {
        metrics.largestFile = fileSize;
      }

      /* -------------------------------------------------------------
       *  Quick path match check. We want to surface files whose PATH
       *  itself matches the supplied patterns, even if their content
       *  does not. This helps catch cases like `LicenseUpgrade_Email_Draft.md`
       *  where the filename contains the keywords while the body might not.
       *  We purposefully run this check BEFORE loading file contents so we
       *  can bail out early for purely‐path matches and save IO.
       * ----------------------------------------------------------- */

      let hasPathMatch = false;
      for (const pattern of compiledPatterns) {
        const regex = new RegExp(pattern.source, "i");
        if (regex.test(file.path)) {
          hasPathMatch = true;
          break;
        }
      }

      if (hasPathMatch) {
        const created = stat?.ctime ? new Date(stat.ctime).toISOString() : new Date().toISOString();
        const modified = stat?.mtime ? new Date(stat.mtime).toISOString() : new Date().toISOString();
        const fileResult: GrepFileHit = {
          file: file.path,
          created,
          modified,
          totalMatches: 0,
          contexts: [],
          fileSize,
          pathMatchOnly: true
        };

        if (!wouldExceedCharLimit(currentSize, fileResult, MAX_CHARS)) {
          fileHits.push(fileResult);
          currentSize += JSON.stringify(fileResult).length;
          resultsCount++;
        } else {
          truncated = true;
        }

        // If we've already reached the result cap, skip expensive content read
        if (resultsCount >= FILESYSTEM_LIMITS.MAX_SEARCH_RESULTS) {
          return;
        }
      }

      // -------------------------------------------------------------
      // Continue with full content search (may add additional contexts)
      // -------------------------------------------------------------

      try {
        const fullContent = isAdapterFile(file)
          ? await readAdapterText(adapter, file.path)
          : await this.app.vault.cachedRead(file);
        metrics.filesProcessed++;
        
        // Skip empty files
        if (!fullContent || fullContent.length === 0) {
          return;
        }
        
        // Determine what content to search based on searchIn parameter
        let content = fullContent;
        let contentOffset = 0; // Track offset for line number calculation
        
        if (searchIn === 'frontmatter' || searchIn === 'both') {
          // Extract frontmatter
          const frontmatterMatch = fullContent.match(/^---\n([\s\S]*?)\n---/);
          if (frontmatterMatch) {
            if (searchIn === 'frontmatter') {
              // Search only frontmatter
              content = frontmatterMatch[0];
            }
            // For 'both', we search the full content
          } else if (searchIn === 'frontmatter') {
            // No frontmatter and we're only searching frontmatter, skip this file
            return;
          }
        } else if (searchIn === 'content') {
          // Skip frontmatter for content-only search
          const frontmatterMatch = fullContent.match(/^---\n[\s\S]*?\n---\n/);
          if (frontmatterMatch) {
            content = fullContent.substring(frontmatterMatch[0].length);
            contentOffset = frontmatterMatch[0].length;
          }
        }
        
        const getLineNumber = createLineCalculator(fullContent);
        
        // Collect matches from all patterns with early exit
        const allMatches: Array<{index: number, text: string, line: number, pattern: string}> = [];
        
        for (const pattern of compiledPatterns) {
          const regex = new RegExp(pattern.source, 'gi');
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
          return;
        }
        
        // Only generate contexts if we're going to use them (lazy evaluation)
        if (resultsCount < FILESYSTEM_LIMITS.MAX_SEARCH_RESULTS) {
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
            while (contextStart > 0 && content[contextStart - 1].match(/\w/) && adjustments < 50) {
              contextStart--;
              adjustments++;
            }
            adjustments = 0;
            while (contextEnd < content.length && content[contextEnd].match(/\w/) && adjustments < 50) {
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
          
          // Create results from merged windows (lazy context generation)
          const fileResults = contextWindows.map(window => {
            let contextStr = content.substring(window.start, window.end);
            
            // Replace all matches in context with highlighted version for each pattern
            for (const pattern of compiledPatterns) {
              contextStr = contextStr.replace(new RegExp(pattern.source, 'gi'), '【$&】');
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
          
          if (fileResults.length > 0) {
            const created = stat?.ctime ? new Date(stat.ctime).toISOString() : new Date().toISOString();
            const modified = stat?.mtime ? new Date(stat.mtime).toISOString() : new Date().toISOString();
            const fileResult = {
              file: file.path,
              created,
              modified,
              totalMatches: allMatches.length,
              contexts: fileResults,
              fileSize // used for ranking
            };
            
            if (!wouldExceedCharLimit(currentSize, fileResult, MAX_CHARS)) {
              fileHits.push(fileResult);
              currentSize += JSON.stringify(fileResult).length;
              resultsCount++;
            } else {
              truncated = true;
            }
          }
        }
        
        // Clear content from memory immediately
        // Note: content variable will be garbage collected after this scope
      } catch {
        metrics.filesSkipped++;
        // Silently skip problematic files
      }
    };
    
    // Process files in batches with yielding
    for (let i = 0; i < filesToSearch.length; i += BATCH_SIZE) {
      // Check timeout before each batch
      if (Date.now() - startTime > MAX_PROCESSING_TIME) {
        metaResults.push({
          file: "_timeout",
          notice: `Search timed out after ${MAX_PROCESSING_TIME / 1000} seconds to prevent UI freeze. Found ${resultsCount} results. Use more specific search terms or paths.`,
          totalMatches: metrics.totalMatches,
          contexts: []
        });
        break;
      }
      
      // Check if we have enough results
      if (resultsCount >= FILESYSTEM_LIMITS.MAX_SEARCH_RESULTS) {
        metaResults.push({
          file: "_summary",
          notice: `Search stopped after ${FILESYSTEM_LIMITS.MAX_SEARCH_RESULTS} files with matches. More results may exist.`,
          totalMatches: metrics.totalMatches,
          contexts: []
        });
        break;
      }
      
      // Process batch of files
      const batch = filesToSearch.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map((file) => processFile(file)));
      
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

    const makeSnippets = (): Array<{ path: string; line: number; text: string }> => {
      const snippets: Array<{ path: string; line: number; text: string }> = [];
      const seen = new Set<string>();
      for (const r of sortedResults) {
        const ctxs = (r.contexts || []) as Array<{ lines: number[]; context: string; matchCount: number }>;
        for (const c of ctxs) {
          const line = Array.isArray(c.lines) && c.lines.length > 0 ? Math.min(...c.lines) : 1;
          const text = `${r.path}:${line}  ${c.context}`;
          const key = `${r.path}|${line}|${c.context}`;
          if (seen.has(key)) continue;
          seen.add(key);
          snippets.push({ path: r.path, line, text });
        }
      }
      return snippets;
    };

    const allSnippets = makeSnippets();
    const totalSnippetCount = allSnippets.length;

    const buildOrder = (n: number): number[] => {
      const head = Math.ceil(n * 0.3);
      const tail = Math.ceil(n * 0.3);
      const order: number[] = [];
      for (let i = 0; i < Math.min(head, n); i++) order.push(i);
      for (let i = Math.max(n - tail, head); i < n; i++) order.push(i);
      for (let i = head; i < Math.max(n - tail, head); i++) order.push(i);
      return order;
    };

    const order = buildOrder(allSnippets.length);

    type SearchCursor = Readonly<{ q: string; o: number }>;
    const encodeCursor = (state: SearchCursor): string => {
      try {
        return utf8ToBase64(JSON.stringify(state));
      } catch {
        return "";
      }
    };
    const decodeCursor = (cursor?: string): SearchCursor | null => {
      if (!cursor || typeof cursor !== 'string') return null;
      try {
        const decoded: unknown = JSON.parse(base64ToUtf8(cursor));
        if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
        const candidate = decoded as Record<string, unknown>;
        return typeof candidate.q === "string" && typeof candidate.o === "number"
          ? { q: candidate.q, o: candidate.o }
          : null;
      } catch {
        return null;
      }
    };
    const qId = `${searchIn}|${patternMode}|${patterns.join('\u0001')}${
      searchPaths === null ? "" : `|paths:${searchPaths.join("\u0001")}`
    }`;
    const rawCursor = requestedCursor;
    const cursorState = decodeCursor(rawCursor ?? undefined);
    if (rawCursor && (!cursorState || cursorState.q !== qId || !Number.isFinite(cursorState.o))) {
      throw new Error("Invalid search cursor for this query.");
    }
    const startOffset = cursorState ? Math.max(0, Math.min(order.length, cursorState.o)) : 0;

    let usedTokens = 0;
    const included: Array<{ path: string; line: number; text: string }> = [];
    let i = startOffset;
    for (; i < order.length; i++) {
      const idx = order[i];
      const snip = allSnippets[idx];
      const t = countTextTokens(snip.text);
      if (usedTokens + t > bodyTokenBudget) break;
      included.push(snip);
      usedTokens += t;
    }

    const formattedResults = formatScoredResults(sortedResults, FILESYSTEM_LIMITS.MAX_SEARCH_RESULTS);
    if (Array.isArray(formattedResults.results)) {
      for (const result of formattedResults.results) delete result.contexts;
    }
    if (metaResults.length > 0) formattedResults.metaInfo = metaResults;
    if (truncated) {
      formattedResults.truncated = true;
      formattedResults.notice = `Results were truncated to stay within the ${MAX_CHARS} character response cap.`;
    }

    const buildResponse = () => {
      const remainingCount = order.length - i;
      let omittedTokens = 0;
      for (let j = i; j < order.length; j++) {
        omittedTokens += countTextTokens(allSnippets[order[j]].text);
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
          next_cursor: i < order.length ? encodeCursor({ q: qId, o: i }) : null,
          total_matches: totalSnippetCount,
          returned_matches: included.length,
          omitted_matches: remainingCount,
          omitted_tokens: omittedTokens
        },
        snippets: included.map((snippet) => snippet.text),
        footer: remainingCount > 0 ? `...[omitted ${omittedTokens} tokens across ${remainingCount} matches]` : ''
      };
    };

    let response = buildResponse();
    while (included.length > 0 && JSON.stringify(response).length > MAX_CHARS) {
      const removed = included.pop()!;
      usedTokens -= countTextTokens(removed.text);
      i -= 1;
      response = buildResponse();
    }
    while (
      Array.isArray(formattedResults.results)
      && formattedResults.results.length > 0
      && JSON.stringify(response).length > MAX_CHARS
    ) {
      formattedResults.results.pop();
      formattedResults.truncated = true;
      response = buildResponse();
    }
    return response;
  }

}
