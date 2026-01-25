import { App, TFile, TFolder, normalizePath } from "obsidian";
import { FindFilesParams, GrepVaultParams } from "../types";
import { FILESYSTEM_LIMITS } from "../constants";
import { countTextTokens } from "../../../utils/tokenCounting";
import {
  createLineCalculator,
  wouldExceedCharLimit,
  shouldExcludeFromSearch,
  fuzzyMatchScore,
  validatePath,
  isHiddenSystemPath,
  listAdapterFiles,
  statAdapterPath,
  readAdapterText,
} from "../utils";
import { extractSearchTerms, calculateScore, sortByScore, formatScoredResults, ScoredResult } from "../searchScoring";
import SystemSculptPlugin from "../../../main";

/**
 * Search operations for MCP Filesystem tools
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

  private getHiddenAllowedPaths(): string[] {
    return this.allowedPaths
      .map((path) => normalizePath(String(path ?? "")).replace(/^\/+/, ""))
      .filter((path) => path.length > 0 && isHiddenSystemPath(path));
  }

  private async listHiddenFiles(): Promise<Array<{ path: string; stat: { size: number; ctime: number; mtime: number } | null; __adapter: true }>> {
    const hiddenRoots = this.getHiddenAllowedPaths();
    if (hiddenRoots.length === 0) return [];
    const adapter: any = this.app.vault.adapter as any;

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
   * Search for files and directories by name patterns - with intelligent scoring
   */
  async findFiles(params: FindFilesParams): Promise<any> {
    const patterns = this.normalizeStringArray((params as any)?.patterns);
    if (patterns.length === 0) {
      throw new Error("Missing required 'patterns'. Provide one or more search terms, e.g., [\"cloudflare\", \"CF_API_TOKEN\"].");
    }
    
    // Extract search terms from patterns
    const originalQuery = patterns.join(' ');
    const searchTerms = extractSearchTerms(originalQuery);
    
    const scoredResults: ScoredResult[] = [];
    const seenPaths = new Set<string>();

    const adapterFiles = await this.listHiddenFiles();
    
    // Search files
    const files = this.app.vault.getFiles();
    for (const file of files) {
      // Exclude chat history and system files
      if (shouldExcludeFromSearch(file, this.plugin)) {
        continue;
      }
      if (!this.isAllowedPath(file.path)) {
        continue;
      }
      if (seenPaths.has(file.path)) {
        continue;
      }
      seenPaths.add(file.path);
      
      // Calculate intelligent score
      const scoreResult = calculateScore(file.path, '', {
        searchTerms,
        originalQuery
      });
      
      // Add metadata
      scoreResult.created = new Date(file.stat.ctime).toISOString();
      scoreResult.modified = new Date(file.stat.mtime).toISOString();
      scoreResult.fileSize = file.stat.size;
      
      scoredResults.push(scoreResult);
    }

    for (const file of adapterFiles) {
      if (seenPaths.has(file.path)) {
        continue;
      }
      seenPaths.add(file.path);

      const scoreResult = calculateScore(file.path, '', {
        searchTerms,
        originalQuery
      });

      const created = file.stat?.ctime ? new Date(file.stat.ctime).toISOString() : undefined;
      const modified = file.stat?.mtime ? new Date(file.stat.mtime).toISOString() : undefined;
      if (created) scoreResult.created = created;
      if (modified) scoreResult.modified = modified;
      scoreResult.fileSize = file.stat?.size ?? 0;

      scoredResults.push(scoreResult);
    }
    
    // Search folders
    const searchFolder = (folder: TFolder) => {
      if (!this.shouldDescend(folder.path)) {
        return;
      }
      for (const child of folder.children) {
        if (child instanceof TFolder) {
          if (this.isAllowedPath(child.path)) {
            // Calculate intelligent score for folder
            const scoreResult = calculateScore(child.path, '', {
              searchTerms,
              originalQuery
            });
            
            // Add metadata if available
            const created = (child as any).stat?.ctime ? new Date((child as any).stat.ctime).toISOString() : undefined;
            const modified = (child as any).stat?.mtime ? new Date((child as any).stat.mtime).toISOString() : undefined;
            
            if (created) scoreResult.created = created;
            if (modified) scoreResult.modified = modified;
            
            scoredResults.push(scoreResult);
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
      const scoreResult = calculateScore(folderPath, '', {
        searchTerms,
        originalQuery
      });
      scoredResults.push(scoreResult);
    }
    
    // Sort by score and format results
    const sortedResults = sortByScore(scoredResults);
    return formatScoredResults(sortedResults, FILESYSTEM_LIMITS.MAX_SEARCH_RESULTS * 3);
  }

  /**
   * Search within note contents using one or more search terms (regex supported) - with intelligent scoring
   */
  async grepVault(params: GrepVaultParams): Promise<any> {
    const patterns = this.normalizeStringArray((params as any)?.patterns);
    const searchIn = (params as any)?.searchIn ?? 'content';
    const requestedPageTokens = Math.max(512, Math.min(4096, Number((params as any)?.pageTokens || FILESYSTEM_LIMITS.MAX_TOOL_RESULT_TOKENS)));
    const bodyTokenBudget = Math.max(256, requestedPageTokens - FILESYSTEM_LIMITS.GREP_FOOTER_TOKENS);
    if (patterns.length === 0) {
      throw new Error("Missing required 'patterns'. Add one or more words or regex patterns, e.g., [\"cloudflare\", \"api key\"].");
    }
    
    // Extract search terms for intelligent scoring
    const originalQuery = patterns.join(' ');
    const searchTerms = extractSearchTerms(originalQuery);
    // We keep two buckets: fileHits (actual matches) and metaResults (info, timeout, etc.)
    const metaResults: any[] = [];
    const fileHits: any[] = [];
    
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
    const adapter: any = this.app.vault.adapter as any;

    type SearchFile = TFile | { path: string; stat: { size: number; ctime: number; mtime: number } | null; __adapter: true };
    const isAdapterFile = (file: SearchFile): file is { path: string; stat: { size: number; ctime: number; mtime: number } | null; __adapter: true } =>
      Boolean((file as any).__adapter);
    const getStat = (file: SearchFile) => (isAdapterFile(file) ? file.stat : file.stat);
    const getSize = (file: SearchFile) => getStat(file)?.size ?? 0;
    
    // Search entire vault using cached access if available
    const getFiles = () => {
      const plugin = (this.app as any).plugins?.plugins?.['systemsculpt-ai'];
      try {
        return plugin?.vaultFileCache?.getAllFiles() || this.app.vault.getFiles();
      } catch (_) {
        return [] as any[];
      }
    };
    
    let filesToSearch: SearchFile[] = getFiles();
    const adapterFiles = await this.listHiddenFiles();
    if (adapterFiles.length > 0) {
      filesToSearch = filesToSearch.concat(adapterFiles);
    }

    // Exclude chat history and system files
    filesToSearch = filesToSearch.filter((file) => {
      if (!this.isAllowedPath(file.path)) return false;
      if (isAdapterFile(file)) return true;
      return !shouldExcludeFromSearch(file, this.plugin);
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
      for (const pattern of patterns) {
        try {
          const regex = new RegExp(pattern, "i");
          if (regex.test(file.path)) {
            hasPathMatch = true;
            break;
          }
        } catch {
          // Ignore invalid regex patterns – we'll handle them later during
          // the normal content matching phase so the user still gets
          // feedback on faulty input.
        }
      }

      if (hasPathMatch) {
        const created = stat?.ctime ? new Date(stat.ctime).toISOString() : new Date().toISOString();
        const modified = stat?.mtime ? new Date(stat.mtime).toISOString() : new Date().toISOString();
        const fileResult = {
          file: file.path,
          created,
          modified,
          totalMatches: 0,
          contexts: [],
          fileSize,
          pathMatchOnly: true
        } as any;

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
        
        for (const pattern of patterns) {
          const regex = new RegExp(pattern, 'gi');
          let match;
          
          while ((match = regex.exec(content)) !== null && allMatches.length < MAX_MATCHES_PER_FILE) {
            const lineNumber = getLineNumber(match.index + contentOffset);
            allMatches.push({
              index: match.index + contentOffset,
              text: match[0],
              line: lineNumber,
              pattern: pattern
            });
            metrics.totalMatches++;
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
            for (const pattern of patterns) {
              contextStr = contextStr.replace(new RegExp(pattern, 'gi'), '【$&】');
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
      } catch (err) {
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
          message: `Search timed out after ${MAX_PROCESSING_TIME / 1000} seconds to prevent UI freeze. Found ${resultsCount} results. Use more specific search terms or paths.`,
          totalMatches: metrics.totalMatches,
          contexts: []
        });
        break;
      }
      
      // Check if we have enough results
      if (resultsCount >= FILESYSTEM_LIMITS.MAX_SEARCH_RESULTS) {
        metaResults.push({
          file: "_summary",
          message: `Search stopped after ${FILESYSTEM_LIMITS.MAX_SEARCH_RESULTS} files with matches. More results may exist.`,
          totalMatches: metrics.totalMatches,
          contexts: []
        });
        break;
      }
      
      // Process batch of files
      const batch = filesToSearch.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map((file) => processFile(file)));
      
      // Yield control to prevent UI freeze (critical for performance)
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    
    // Add performance summary if processing took significant time or had issues
    metrics.processingTime = Date.now() - startTime;
    
    if (metrics.processingTime > 2000 || metrics.filesSkipped > 10 || metrics.timeouts > 0) {
      metaResults.push({
        file: "_performance",
        message: `Search completed in ${metrics.processingTime}ms. Processed: ${metrics.filesProcessed} files, Skipped: ${metrics.filesSkipped} files, Total matches: ${metrics.totalMatches}. Largest file: ${Math.round(metrics.largestFile / 1024)}KB.`,
        totalMatches: metrics.totalMatches,
        contexts: []
      });
    }

    // If we failed to find any matches at all, provide a concise but helpful
    // no-result summary so the user understands why nothing useful came
    // back and what they can try next.
    if (fileHits.length === 0) {
      metaResults.push({
        file: "_no_matches",
        message: `No matches found for: ${patterns.map(p => `"${p}"`).join(", ")}. Try different words, adjust where you search (text vs. properties), or limit the search to a specific folder for speed.`,
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
        contentSnippet = hit.contexts.map((c: any) => c.context).join(' ');
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

    const encodeCursor = (state: any): string => {
      try { return Buffer.from(JSON.stringify(state)).toString('base64'); } catch { return ''; }
    };
    const decodeCursor = (cursor?: string): any | null => {
      if (!cursor || typeof cursor !== 'string') return null;
      try { return JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')); } catch { return null; }
    };
    const qId = `${searchIn}|${patterns.join('\u0001')}`;
    const cursorState = decodeCursor((params as any)?.cursor);
    const startOffset = cursorState && cursorState.q === qId && Number.isFinite(cursorState.o) ? Math.max(0, Math.min(order.length, cursorState.o)) : 0;

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

    const remainingCount = order.length - i;
    let omittedTokens = 0;
    if (remainingCount > 0) {
      for (let j = i; j < order.length; j++) {
        omittedTokens += countTextTokens(allSnippets[order[j]].text);
      }
    }

    const formattedResults = formatScoredResults(sortedResults, FILESYSTEM_LIMITS.MAX_SEARCH_RESULTS);
    if (metaResults.length > 0) formattedResults.metaInfo = metaResults;
    if (truncated) {
      formattedResults.truncated = true;
      formattedResults.notice = `Results were truncated to stay within the ${MAX_CHARS} character response cap.`;
    }

    const sliceText = included.map(s => s.text);
    const footerNote = remainingCount > 0 ? `...[omitted ${omittedTokens} tokens across ${remainingCount} matches]` : '';

    const nextCursor = i < order.length ? encodeCursor({ q: qId, o: i }) : null;

    const response = {
      ...formattedResults,
      page: {
        tokensBudget: requestedPageTokens,
        tokensUsed: usedTokens,
        bodyTokenBudget,
        next_cursor: nextCursor,
        total_matches: totalSnippetCount,
        returned_matches: included.length,
        omitted_matches: remainingCount,
        omitted_tokens: omittedTokens
      },
      snippets: sliceText,
      footer: footerNote
    } as any;

    return response;
  }

}
