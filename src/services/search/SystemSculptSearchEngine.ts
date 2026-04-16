import { App, EventRef, TFile } from "obsidian";
import SystemSculptPlugin from "../../main";
import { shouldExcludeFromSearch, fuzzyMatchScore } from "../../mcp-tools/filesystem/searchUtils";
import { extractCanvasText } from "./canvasTextExtractor";

export type SearchMode = "smart" | "lexical" | "semantic";
export type SortMode = "relevance" | "recency";

export interface SearchHit {
  path: string;
  title: string;
  excerpt?: string;
  score: number;
  lexScore?: number;
  semScore?: number;
  origin: "lexical" | "semantic" | "blend" | "recent";
  updatedAt?: number;
  size?: number;
}

export interface EmbeddingsIndicator {
  enabled: boolean;
  ready: boolean;
  available: boolean;
  reason?: string;
  processed?: number;
  total?: number;
}

export interface SearchStats {
  totalMs: number;
  lexMs?: number;
  semMs?: number;
  indexMs?: number;
  indexedCount: number;
  inspectedCount: number;
  mode: SearchMode;
  usedEmbeddings: boolean;
  embeddingsEligible?: boolean;
  indexingPending?: boolean;
  metadataOnly?: boolean;
}

export interface SearchResponse {
  results: SearchHit[];
  stats: SearchStats;
  embeddings: EmbeddingsIndicator;
}

interface IndexedDocument {
  path: string;
  title: string;
  lowerTitle: string;
  lowerPath: string;
  titleTokens: Set<string>;
  pathTokens: Set<string>;
  bodyTokens: Set<string>;
  tokens: Set<string>;
  body: string; // truncated, lowercased content (frontmatter stripped)
  rawBody: string; // truncated, original casing for excerpts
  preview: string; // short excerpt for list view
  mtime: number;
  size: number;
}

interface QueryTerm {
  value: string;
  exact: Set<string>;
  prefix: Set<string>;
  fuzzy: Set<string>;
}

interface CachedPreview {
  key: string;
  preview: string;
}

interface MetadataTokenSnapshot {
  lowerTitle: string;
  lowerPath: string;
  titleTokens: Set<string>;
  pathTokens: Set<string>;
}

interface SearchableEmbeddingsManager {
  awaitReady?: () => Promise<void>;
  searchSimilar: (query: string, limit: number, signal?: AbortSignal) => Promise<Array<{
    path: string;
    score?: number;
    metadata?: {
      title?: string | null;
      excerpt?: string;
      lastModified?: number;
    };
  }>>;
  isReady?: () => boolean;
  hasAnyEmbeddings?: () => boolean;
  getStats?: () => {
    total?: number;
    processed?: number;
    present?: number;
    needsProcessing?: number;
  };
}

export class SystemSculptSearchEngine {
  private app: App;
  private plugin: SystemSculptPlugin;
  private index: Map<string, IndexedDocument> = new Map();
  private tokenIndex: Map<string, Set<string>> = new Map();
  private tokenVocabulary: Set<string> = new Set();
  private sortedTokenVocabulary: string[] = [];
  private tokenLengthBuckets: Map<number, string[]> = new Map();
  private tokenLookupsDirty = true;
  private eligibleFilesCache: TFile[] | null = null;
  private eligibleFilesCacheSignature: string | null = null;
  private metadataTokenCache: Map<string, MetadataTokenSnapshot> = new Map();
  private recentHitsCache: { limit: number; hits: SearchHit[] } | null = null;
  private recentPreviewCache: Map<string, CachedPreview> = new Map();
  private indexPromise: Promise<void> | null = null;
  private contentIndexReady = false;
  private indexGeneration = 0;
  private scheduledIndexHandle: number | null = null;
  private dirtyPaths: Set<string> = new Set();
  private eventRefs: EventRef[] = [];
  private workspaceEventRefs: EventRef[] = [];
  private readonly INDEXABLE_EXTENSIONS = new Set(["md", "markdown", "canvas"]);
  private readonly MAX_INDEX_CHARS = 6500;
  private readonly MAX_EXCERPT_SOURCE_CHARS = 2200;
  private readonly PREVIEW_CHARS = 240;
  private readonly CANDIDATE_LIMIT = 320;
  private readonly PREFIX_TOKEN_LIMIT = 160;
  private readonly FUZZY_TOKEN_LIMIT = 80;
  private readonly CONTENT_CONCURRENCY = 10;
  private readonly INDEX_BUILD_YIELD_EVERY = 128;
  private readonly RECENT_PREVIEW_CONCURRENCY = 2;
  private readonly MAX_RECENT_PREVIEW_FILE_BYTES = 1024 * 1024;
  private readonly SEMANTIC_TIMEOUT_MS = 1500;
  private readonly UNICODE_TOKEN_PATTERN = /[\p{L}\p{N}\p{M}]+/gu;
  private lastLexicalInspect = 0;

  constructor(app: App, plugin: SystemSculptPlugin) {
    this.app = app;
    this.plugin = plugin;
    this.registerVaultWatchers();
  }

  /**
   * Run a search across the vault
   */
  async search(query: string, options?: { mode?: SearchMode; sort?: SortMode; limit?: number; signal?: AbortSignal }): Promise<SearchResponse> {
    const mode: SearchMode = options?.mode ?? "smart";
    const sort: SortMode = options?.sort ?? "relevance";
    const limit = options?.limit ?? 80;
    const signal = options?.signal;

    const searchStart = performance.now();
    const normalizedQuery = query.trim().toLowerCase();
    const terms = normalizedQuery.split(/\s+/).filter(Boolean);
    const phrase = normalizedQuery;

    if (terms.length === 0) {
      const recents = await this.getRecent(limit);
      return {
        results: recents,
        stats: {
          totalMs: performance.now() - searchStart,
          indexMs: 0,
          indexedCount: this.index.size,
          inspectedCount: 0,
          mode,
          usedEmbeddings: false,
          embeddingsEligible: false,
        },
        embeddings: this.getEmbeddingsIndicator(),
      };
    }

    if (signal?.aborted) {
      throw new DOMException("Search aborted", "AbortError");
    }

    if (mode === "smart" && !this.contentIndexReady) {
      const metadataStart = performance.now();
      const metadataHits = this.runMetadataSearch(terms, phrase, limit, sort);
      this.scheduleIndexing();
      const totalMs = performance.now() - searchStart;
      return {
        results: metadataHits,
        stats: {
          totalMs,
          lexMs: performance.now() - metadataStart,
          indexMs: 0,
          indexedCount: this.index.size,
          inspectedCount: metadataHits.length,
          mode,
          usedEmbeddings: false,
          embeddingsEligible: false,
          indexingPending: true,
          metadataOnly: true,
        },
        embeddings: this.getEmbeddingsIndicator(),
      };
    }

    const indexStart = performance.now();
    this.refreshEligibilityIfChanged();
    await this.ensureIndex();
    await this.refreshDirtyIndex();
    const indexMs = performance.now() - indexStart;
    this.lastLexicalInspect = 0;

    if (signal?.aborted) {
      throw new DOMException("Search aborted", "AbortError");
    }

    const lexStart = performance.now();
    const lexicalHits = this.runLexicalSearch(terms, phrase, limit, sort);
    const lexMs = performance.now() - lexStart;

    let semanticHits: SearchHit[] = [];
    let semMs: number | undefined;
    let usedEmbeddings = false;

    let embeddingsIndicator = this.getEmbeddingsIndicator();
    // Explicit semantic requests should lazily bootstrap the embeddings manager
    // so a fresh session (or delayed autostart) can still produce semantic hits
    // instead of silently falling back to lexical-only.
    if (mode === "semantic" && embeddingsIndicator.enabled && !this.getExistingEmbeddingsManager()) {
      this.ensureEmbeddingsManager();
      embeddingsIndicator = this.getEmbeddingsIndicator();
    }
    const embeddingsEligible = this.shouldUseEmbeddings(mode, embeddingsIndicator, terms);

    if (embeddingsEligible) {
      const semStart = performance.now();
      semanticHits = await this.runSemanticSearch(query, limit, signal);
      semMs = performance.now() - semStart;
      usedEmbeddings = semanticHits.length > 0;
    } else if (mode === "semantic" && (!embeddingsIndicator.enabled || !embeddingsIndicator.available)) {
      // Explicit semantic request but embeddings not ready; keep usedEmbeddings false and rely on lexical fallback
    }

    const results = this.mergeResults(lexicalHits, semanticHits, limit, mode);

    const totalMs = performance.now() - searchStart;

    return {
      results,
      stats: {
        totalMs,
        lexMs,
        semMs,
        indexMs,
        indexedCount: this.index.size,
        inspectedCount: this.lastLexicalInspect,
        mode,
        usedEmbeddings,
        embeddingsEligible,
      },
      embeddings: embeddingsIndicator,
    };
  }

  /**
   * Recent files snapshot for empty queries
   */
  async getRecent(limit = 25): Promise<SearchHit[]> {
    if (!this.recentHitsCache || this.recentHitsCache.limit < limit) {
      const recentFiles = this.selectRecentFiles(this.getEligibleFiles(), limit);
      this.recentHitsCache = {
        limit,
        hits: recentFiles.map((file) => {
          const indexed = this.index.get(file.path);
          return {
            path: file.path,
            title: indexed?.title ?? file.basename,
            excerpt: indexed?.preview,
            score: 0.5,
            origin: "recent" as const,
            updatedAt: file.stat?.mtime || 0,
            size: file.stat?.size || 0,
          };
        }),
      };
    }

    return this.recentHitsCache.hits.slice(0, limit);
  }

  async getRecentPreviews(paths: string[], limit = 25, signal?: AbortSignal): Promise<Map<string, string>> {
    const previews = new Map<string, string>();
    const uniquePaths = Array.from(new Set(paths)).slice(0, limit);
    const tasks = uniquePaths.map((path) => async () => {
      if (signal?.aborted) return;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile) || !this.isEligible(file)) return;
      const cacheKey = this.previewCacheKey(file);
      const cached = this.recentPreviewCache.get(file.path);
      if (cached?.key === cacheKey) {
        previews.set(file.path, cached.preview);
        return;
      }

      if ((file.stat?.size || 0) > this.MAX_RECENT_PREVIEW_FILE_BYTES) {
        return;
      }

      try {
        const content = await this.safeRead(file);
        if (signal?.aborted) return;
        const preview = this.buildPreviewFromText(this.getIndexText(file, content));
        if (preview) {
          previews.set(path, preview);
          this.recentPreviewCache.set(file.path, { key: cacheKey, preview });
        }
      } catch {
        // Skip failed preview hydration.
      }
    });

    await this.runLimited(tasks, this.RECENT_PREVIEW_CONCURRENCY);
    return previews;
  }

  startIndexing(): Promise<void> {
    return this.ensureIndex();
  }

  async whenIndexReady(): Promise<void> {
    await this.ensureIndex();
  }

  destroy(): void {
    this.eventRefs.forEach((ref) => this.app.vault.offref(ref));
    this.eventRefs = [];
    const workspace = this.app.workspace as any;
    this.workspaceEventRefs.forEach((ref) => {
      if (typeof workspace.offref === "function") {
        workspace.offref(ref);
      } else if (typeof (ref as any)?.unload === "function") {
        (ref as any).unload();
      }
    });
    this.workspaceEventRefs = [];
    this.clearScheduledIndexing();
    this.index.clear();
    this.tokenIndex.clear();
    this.tokenVocabulary.clear();
    this.sortedTokenVocabulary = [];
    this.tokenLengthBuckets.clear();
    this.tokenLookupsDirty = true;
    this.eligibleFilesCache = null;
    this.eligibleFilesCacheSignature = null;
    this.metadataTokenCache.clear();
    this.recentHitsCache = null;
    this.recentPreviewCache.clear();
    this.dirtyPaths.clear();
    this.indexPromise = null;
    this.contentIndexReady = false;
  }

  private registerVaultWatchers() {
    this.eventRefs.push(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && this.isEligible(file)) {
          this.dirtyPaths.add(file.path);
          this.recentHitsCache = null;
          this.recentPreviewCache.delete(file.path);
        }
      })
    );

    this.eventRefs.push(
      this.app.vault.on("create", (file) => {
        this.eligibleFilesCache = null;
        this.eligibleFilesCacheSignature = null;
        if (file instanceof TFile) {
          this.metadataTokenCache.delete(file.path);
        }
        if (file instanceof TFile && this.isEligible(file)) {
          this.dirtyPaths.add(file.path);
          this.recentHitsCache = null;
          this.recentPreviewCache.delete(file.path);
        }
      })
    );

    this.eventRefs.push(
      this.app.vault.on("delete", (file) => {
        this.eligibleFilesCache = null;
        this.eligibleFilesCacheSignature = null;
        if (file instanceof TFile) {
          this.metadataTokenCache.delete(file.path);
          const existing = this.index.get(file.path);
          if (existing) {
            this.removeFromTokenIndex(existing);
          }
          this.index.delete(file.path);
          this.dirtyPaths.delete(file.path);
          this.recentHitsCache = null;
          this.recentPreviewCache.delete(file.path);
        }
      })
    );

    this.eventRefs.push(
      this.app.vault.on("rename", (file, oldPath) => {
        this.eligibleFilesCache = null;
        this.eligibleFilesCacheSignature = null;
        if (!(file instanceof TFile)) return;
        this.metadataTokenCache.delete(oldPath);
        this.metadataTokenCache.delete(file.path);
        const existing = this.index.get(oldPath);
        if (existing) {
          this.removeFromTokenIndex(existing);
        }
        this.index.delete(oldPath);
        this.recentPreviewCache.delete(oldPath);
        if (this.isEligible(file)) {
          this.dirtyPaths.add(file.path);
          this.recentPreviewCache.delete(file.path);
        }
        this.recentHitsCache = null;
      })
    );

    if (typeof this.app.workspace?.on === "function") {
      this.workspaceEventRefs.push(
        this.app.workspace.on("systemsculpt:settings-updated", () => {
          this.clearIndexes();
        })
      );
    }
  }

  private async ensureIndex(): Promise<void> {
    if (this.contentIndexReady) return;
    if (this.indexPromise) {
      await this.indexPromise;
      return;
    }

    const generation = this.indexGeneration;
    this.indexPromise = (async () => {
      const files = this.getEligibleFiles();
      const built = await this.buildIndex(files, false, generation);
      if (built && generation === this.indexGeneration) {
        this.contentIndexReady = true;
      }
    })();

    try {
      await this.indexPromise;
    } catch (error) {
      this.indexPromise = null;
      this.contentIndexReady = false;
      throw error;
    }
  }

  private clearIndexes(): void {
    this.indexGeneration += 1;
    this.clearScheduledIndexing();
    this.index.clear();
    this.tokenIndex.clear();
    this.tokenVocabulary.clear();
    this.sortedTokenVocabulary = [];
    this.tokenLengthBuckets.clear();
    this.tokenLookupsDirty = true;
    this.eligibleFilesCache = null;
    this.eligibleFilesCacheSignature = null;
    this.metadataTokenCache.clear();
    this.recentHitsCache = null;
    this.recentPreviewCache.clear();
    this.dirtyPaths.clear();
    this.indexPromise = null;
    this.contentIndexReady = false;
  }

  private scheduleIndexing(): void {
    if (this.contentIndexReady || this.indexPromise || this.scheduledIndexHandle !== null) return;
    this.scheduledIndexHandle = window.setTimeout(() => {
      this.scheduledIndexHandle = null;
      void this.startIndexing().catch(() => {
        // Explicit searches can retry indexing.
      });
    }, 0);
  }

  private clearScheduledIndexing(): void {
    if (this.scheduledIndexHandle !== null) {
      window.clearTimeout(this.scheduledIndexHandle);
      this.scheduledIndexHandle = null;
    }
  }

  private async refreshDirtyIndex(): Promise<void> {
    if (this.dirtyPaths.size === 0) return;
    const paths = Array.from(this.dirtyPaths);
    this.dirtyPaths.clear();

    const filesToRefresh = paths
      .map((p) => this.app.vault.getAbstractFileByPath(p))
      .filter((f): f is TFile => f instanceof TFile && this.isEligible(f));

    if (filesToRefresh.length === 0) {
      return;
    }

    await this.buildIndex(filesToRefresh, true, this.indexGeneration);
  }

  private async buildIndex(files: TFile[], incremental = false, generation = this.indexGeneration): Promise<boolean> {
    if (!incremental) {
      const nextIndex = new Map<string, IndexedDocument>();
      const nextTokenIndex = new Map<string, Set<string>>();
      const nextVocabulary = new Set<string>();

      const tasks = files.map((file) => async () => {
        try {
          const doc = await this.indexFile(file);
          if (!doc || generation !== this.indexGeneration) return;
          nextIndex.set(file.path, doc);
          this.addToTokenIndex(doc, nextTokenIndex, nextVocabulary);
        } catch {
          // Skip failed file
        }
      });

      await this.runLimited(tasks, this.CONTENT_CONCURRENCY, this.INDEX_BUILD_YIELD_EVERY);
      if (generation !== this.indexGeneration) return false;

      this.index = nextIndex;
      this.tokenIndex = nextTokenIndex;
      this.tokenVocabulary = nextVocabulary;
      this.rebuildTokenLookups();
      this.recentHitsCache = null;
      return true;
    }

    const tasks = files.map((file) => async () => {
      try {
        if (generation !== this.indexGeneration) return;
        const doc = await this.indexFile(file);
        if (!doc || generation !== this.indexGeneration) return;

        const existing = this.index.get(file.path);
        if (existing) {
          this.removeFromTokenIndex(existing);
        }
        this.index.set(file.path, doc);
        this.addToTokenIndex(doc);
      } catch {
        // Skip failed file
      }
    });

    await this.runLimited(tasks, this.CONTENT_CONCURRENCY, this.INDEX_BUILD_YIELD_EVERY);
    if (generation !== this.indexGeneration) return false;
    this.tokenLookupsDirty = true;
    this.recentHitsCache = null;
    return true;
  }

  private async indexFile(file: TFile): Promise<IndexedDocument | null> {
    const content = await this.safeRead(file);
    const extracted = this.getIndexText(file, content);
    const metadata = this.getMetadataTokenSnapshot(file);
    const rawBody = extracted.slice(0, this.MAX_EXCERPT_SOURCE_CHARS);
    const body = extracted.slice(0, this.MAX_INDEX_CHARS).toLowerCase();
    const preview = this.buildPreviewFromText(extracted);
    const bodyTokens = this.tokenizeSearchText(body);
    const tokens = new Set([...metadata.titleTokens, ...metadata.pathTokens, ...bodyTokens]);

    return {
      path: file.path,
      title: file.basename,
      lowerTitle: metadata.lowerTitle,
      lowerPath: metadata.lowerPath,
      titleTokens: metadata.titleTokens,
      pathTokens: metadata.pathTokens,
      bodyTokens,
      tokens,
      body,
      rawBody,
      preview,
      mtime: file.stat?.mtime || 0,
      size: file.stat?.size || 0,
    };
  }

  private async safeRead(file: TFile): Promise<string> {
    try {
      return await this.app.vault.cachedRead(file);
    } catch {
      return "";
    }
  }

  private getEligibleFiles(): TFile[] {
    const signature = this.computeEligibilitySignature();
    if (this.eligibleFilesCache && this.eligibleFilesCacheSignature === signature) {
      return this.eligibleFilesCache;
    }

    const cached = this.plugin.vaultFileCache?.getAllFilesView?.() ?? this.plugin.vaultFileCache?.getAllFiles?.();
    const files = Array.isArray(cached) ? cached : this.app.vault.getFiles();
    this.eligibleFilesCache = Array.from(files).filter((f) => this.isEligible(f));
    this.eligibleFilesCacheSignature = signature;
    return this.eligibleFilesCache;
  }

  /**
   * If the user's "Excluded files" filters changed since the last search,
   * drop any now-ineligible indexed docs and invalidate the eligible-files
   * snapshot so the next search reflects the new exclusions.
   */
  private refreshEligibilityIfChanged(): void {
    const signature = this.computeEligibilitySignature();
    if (this.eligibleFilesCacheSignature === null || this.eligibleFilesCacheSignature === signature) {
      return;
    }
    this.pruneIndexForCurrentEligibility();
    this.eligibleFilesCache = null;
    this.eligibleFilesCacheSignature = null;
  }

  private pruneIndexForCurrentEligibility(): void {
    if (this.index.size === 0) return;
    for (const [path] of this.index) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile && this.isEligible(file)) continue;
      const doc = this.index.get(path);
      if (doc) this.removeFromTokenIndex(doc);
      this.index.delete(path);
      this.dirtyPaths.delete(path);
      this.recentPreviewCache.delete(path);
    }
    this.recentHitsCache = null;
  }

  /**
   * Produce a cheap signature of the inputs that `isEligible` reads from outside
   * our own settings. We snapshot Obsidian's `userIgnoreFilters` so the cached
   * eligible-files list refreshes when the user edits core "Excluded files"
   * without needing a plugin settings event.
   */
  private computeEligibilitySignature(): string {
    try {
      const vault = this.app.vault as unknown as { getConfig?: (key: string) => unknown };
      const filters = typeof vault.getConfig === "function" ? vault.getConfig("userIgnoreFilters") : null;
      if (Array.isArray(filters) && filters.length > 0) {
        return filters.map((value) => String(value)).join("\u0000");
      }
    } catch {
      // Vault config lookup may throw on some platforms; treat as "no filters".
    }
    return "";
  }

  private getMetadataTokenSnapshot(file: TFile): MetadataTokenSnapshot {
    const cached = this.metadataTokenCache.get(file.path);
    if (cached) return cached;

    const snapshot: MetadataTokenSnapshot = {
      lowerTitle: file.basename.toLowerCase(),
      lowerPath: file.path.toLowerCase(),
      titleTokens: this.tokenizeSearchText(file.basename),
      pathTokens: this.tokenizeSearchText(file.path),
    };
    this.metadataTokenCache.set(file.path, snapshot);
    return snapshot;
  }

  private selectRecentFiles(files: TFile[], limit: number): TFile[] {
    if (limit <= 0) return [];
    const top: TFile[] = [];
    for (const file of files) {
      const mtime = file.stat?.mtime || 0;
      if (top.length === 0) {
        top.push(file);
        continue;
      }

      let insertAt = top.findIndex((candidate) => mtime > (candidate.stat?.mtime || 0));
      if (insertAt === -1) insertAt = top.length;

      if (insertAt < limit) {
        top.splice(insertAt, 0, file);
        if (top.length > limit) top.pop();
      } else if (top.length < limit) {
        top.push(file);
      }
    }
    return top;
  }

  private previewCacheKey(file: TFile): string {
    return `${file.path}:${file.stat?.mtime || 0}:${file.stat?.size || 0}`;
  }

  private isEligible(file: TFile): boolean {
    if (!this.INDEXABLE_EXTENSIONS.has((file.extension ?? "").toLowerCase())) return false;
    return !shouldExcludeFromSearch(file, this.plugin);
  }

  private stripFrontmatter(content: string): string {
    return content.replace(/^---[\s\S]*?---\n/, "");
  }

  private getIndexText(file: TFile, content: string): string {
    const ext = (file.extension ?? "").toLowerCase();
    if (ext === "canvas") {
      return extractCanvasText(content, { maxChars: this.MAX_INDEX_CHARS });
    }

    return this.stripFrontmatter(content);
  }

  private buildPreviewFromText(text: string): string {
    const trimmed = text.trim();
    if (trimmed.length <= this.PREVIEW_CHARS) return trimmed;
    return `${trimmed.slice(0, this.PREVIEW_CHARS)}...`;
  }

  private runLexicalSearch(terms: string[], phrase: string, limit: number, sort: SortMode): SearchHit[] {
    const queryTerms = this.buildQueryTerms(terms);
    const candidates = this.collectCandidateDocs(queryTerms, limit);
    const candidateMap = new Map<string, IndexedDocument>();

    for (const doc of candidates) {
      candidateMap.set(doc.path, doc);
    }
    if (this.shouldUseSubstringCandidateFallback(queryTerms, phrase, candidateMap.size)) {
      for (const doc of this.collectSubstringCandidateDocs(terms, phrase, limit)) {
        candidateMap.set(doc.path, doc);
      }
    }

    const pool = Array.from(candidateMap.values());
    this.lastLexicalInspect = pool.length;

    const scored = pool
      .map((doc) => this.scoreDocument(doc, queryTerms, phrase))
      .filter((r): r is SearchHit => r !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit * 2); // keep extra for merge step

    if (sort === "recency") {
      scored.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || b.score - a.score);
    }

    return scored;
  }

  private scoreDocument(doc: IndexedDocument, queryTerms: QueryTerm[], phrase: string): SearchHit | null {
    if (queryTerms.length === 0) return null;
    let total = 0;
    let matchedTerms = 0;
    let phraseMatched = false;

    for (const term of queryTerms) {
      const fieldScore = this.scoreTermInDocument(doc, term);
      if (fieldScore > 0) {
        total += fieldScore;
        matchedTerms += 1;
      }
    }

    if (phrase) {
      if (doc.lowerTitle.includes(phrase)) {
        total += 20;
        phraseMatched = true;
      }
      if (doc.lowerPath.includes(phrase)) {
        total += 10;
        phraseMatched = true;
      }
      if (doc.body.includes(phrase)) {
        total += 14;
        phraseMatched = true;
      }
    }

    if (matchedTerms === 0 && !phraseMatched) return null;

    const coverageRatio = matchedTerms / queryTerms.length;
    const coverageBonus = matchedTerms > 0 ? coverageRatio * 16 : 0;
    total += coverageBonus;

    total += this.computeRecencyBoost(doc.mtime) * Math.max(0.15, coverageRatio);

    const maxPossible = queryTerms.length * 24 + 60;
    const score = Math.min(1, total / maxPossible);

    if (score <= 0) return null;

    return {
      path: doc.path,
      title: doc.title,
      excerpt: this.extractExcerpt(doc, queryTerms.map((term) => term.value), phrase),
      score,
      lexScore: score,
      origin: "lexical",
      updatedAt: doc.mtime,
      size: doc.size,
    };
  }

  private scoreTermInDocument(doc: IndexedDocument, term: QueryTerm): number {
    const exactTitle = this.hasAny(doc.titleTokens, term.exact);
    const exactPath = this.hasAny(doc.pathTokens, term.exact);
    const exactBody = this.hasAny(doc.bodyTokens, term.exact);

    let total = 0;
    if (exactTitle) total += 14;
    if (exactPath) total += 7;
    if (exactBody) total += 5;

    if (total > 0) return total;

    const prefixTitle = this.hasAny(doc.titleTokens, term.prefix);
    const prefixPath = this.hasAny(doc.pathTokens, term.prefix);
    const prefixBody = this.hasAny(doc.bodyTokens, term.prefix);
    if (prefixTitle) total += 11;
    if (prefixPath) total += 5;
    if (prefixBody) total += 3.5;

    if (total > 0) return total;

    const fuzzyTitle = this.hasAny(doc.titleTokens, term.fuzzy);
    const fuzzyPath = this.hasAny(doc.pathTokens, term.fuzzy);
    const fuzzyBody = this.hasAny(doc.bodyTokens, term.fuzzy);
    if (fuzzyTitle) total += 9;
    if (fuzzyPath) total += 4;
    if (fuzzyBody) total += 2.5;

    if (total > 0) return total;

    // Non-tokenizable terms (e.g. emoji, single characters, symbol-only) have
    // empty exact/prefix/fuzzy sets, so token-based scoring always returns 0
    // even when the candidate pool added the doc via substring fallback. Score
    // these by substring so mixed queries like "launch 🚀" still credit docs
    // that only contain the non-tokenizable portion.
    if (term.exact.size === 0 && term.prefix.size === 0 && term.fuzzy.size === 0 && term.value.length > 0) {
      if (doc.lowerTitle.includes(term.value)) total += 9;
      if (doc.lowerPath.includes(term.value)) total += 4;
      if (doc.body.includes(term.value)) total += 3;
    }

    return total;
  }

  private computeRecencyBoost(mtime: number | undefined): number {
    if (!mtime) return 0;
    const ageDays = (Date.now() - mtime) / (1000 * 60 * 60 * 24);
    if (ageDays <= 1) return 8;
    if (ageDays <= 7) return 6;
    if (ageDays <= 30) return 3;
    if (ageDays <= 90) return 1.5;
    return 0.5;
  }

  private tokenizeSearchText(text: string): Set<string> {
    const tokens = text
      .toLowerCase()
      .match(this.UNICODE_TOKEN_PATTERN);
    if (!tokens) return new Set();
    return new Set(tokens.filter((token) => token.length > 1));
  }

  private addToTokenIndex(
    doc: IndexedDocument,
    tokenIndex: Map<string, Set<string>> = this.tokenIndex,
    tokenVocabulary: Set<string> = this.tokenVocabulary
  ): void {
    for (const token of doc.tokens) {
      tokenVocabulary.add(token);
      let paths = tokenIndex.get(token);
      if (!paths) {
        paths = new Set();
        tokenIndex.set(token, paths);
      }
      paths.add(doc.path);
    }
    if (tokenIndex === this.tokenIndex) {
      this.tokenLookupsDirty = true;
    }
  }

  private removeFromTokenIndex(
    doc: IndexedDocument,
    tokenIndex: Map<string, Set<string>> = this.tokenIndex,
    tokenVocabulary: Set<string> = this.tokenVocabulary
  ): void {
    for (const token of doc.tokens) {
      const paths = tokenIndex.get(token);
      if (!paths) continue;
      paths.delete(doc.path);
      if (paths.size === 0) {
        tokenIndex.delete(token);
        tokenVocabulary.delete(token);
      }
    }
    if (tokenIndex === this.tokenIndex) {
      this.tokenLookupsDirty = true;
    }
  }

  private buildQueryTerms(terms: string[]): QueryTerm[] {
    this.ensureTokenLookups();
    return terms.map((value) => {
      const exact = new Set<string>();
      const prefix = new Set<string>();
      const fuzzy = new Set<string>();

      if (this.tokenIndex.has(value)) {
        exact.add(value);
      }

      if (value.length >= 3) {
        for (const token of this.findPrefixTokens(value, this.PREFIX_TOKEN_LIMIT)) {
          if (token === value) continue;
          prefix.add(token);
        }
        for (const token of this.findIndexedQueryPrefixes(value, this.PREFIX_TOKEN_LIMIT - prefix.size)) {
          if (token === value) continue;
          prefix.add(token);
        }

        if (value.length >= 5 && prefix.size < 16) {
          const maxGap = Math.max(2, Math.floor(value.length * 0.45));
          let fuzzyCount = 0;
          for (const token of this.iterLengthBucketTokens(value.length, maxGap)) {
            if (token === value || prefix.has(token)) continue;
            const fuzzyScore = fuzzyMatchScore(value, token);
            if (fuzzyScore !== null && fuzzyScore <= maxGap) {
              fuzzy.add(token);
              fuzzyCount += 1;
              if (fuzzyCount >= this.FUZZY_TOKEN_LIMIT) break;
            }
          }
        }
      }

      return { value, exact, prefix, fuzzy };
    });
  }

  private ensureTokenLookups(): void {
    if (!this.tokenLookupsDirty) return;
    this.rebuildTokenLookups();
  }

  private rebuildTokenLookups(): void {
    this.sortedTokenVocabulary = Array.from(this.tokenVocabulary).sort();
    this.tokenLengthBuckets.clear();
    for (const token of this.sortedTokenVocabulary) {
      const bucket = this.tokenLengthBuckets.get(token.length) ?? [];
      bucket.push(token);
      this.tokenLengthBuckets.set(token.length, bucket);
    }
    this.tokenLookupsDirty = false;
  }

  private findPrefixTokens(prefix: string, limit: number): string[] {
    const matches: string[] = [];
    let index = this.lowerBound(this.sortedTokenVocabulary, prefix);
    while (
      index < this.sortedTokenVocabulary.length &&
      this.sortedTokenVocabulary[index].startsWith(prefix) &&
      matches.length < limit
    ) {
      matches.push(this.sortedTokenVocabulary[index]);
      index += 1;
    }
    return matches;
  }

  private findIndexedQueryPrefixes(value: string, limit: number): string[] {
    if (limit <= 0) return [];
    const matches: string[] = [];
    for (let length = value.length - 1; length >= 3 && matches.length < limit; length -= 1) {
      const prefix = value.slice(0, length);
      if (this.tokenIndex.has(prefix)) {
        matches.push(prefix);
      }
    }
    return matches;
  }

  private lowerBound(values: string[], target: string): number {
    let low = 0;
    let high = values.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (values[mid] < target) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    return low;
  }

  private *iterLengthBucketTokens(length: number, maxGap: number): Iterable<string> {
    const min = Math.max(1, length - maxGap);
    const max = length + maxGap;
    for (let bucketLength = min; bucketLength <= max; bucketLength += 1) {
      const bucket = this.tokenLengthBuckets.get(bucketLength);
      if (bucket) yield* bucket;
    }
  }

  private collectCandidateDocs(queryTerms: QueryTerm[], limit: number): IndexedDocument[] {
    const counts = new Map<string, number>();
    for (const term of queryTerms) {
      const termPaths = this.pathsForQueryTerm(term);
      for (const path of termPaths) {
        counts.set(path, (counts.get(path) ?? 0) + 1);
      }
    }

    if (counts.size === 0) {
      return [];
    }

    const targetMatches = queryTerms.length >= 3
      ? Math.max(2, queryTerms.length - 1)
      : 1;

    let candidates = this.docsForPathCounts(counts, targetMatches, limit);
    if (candidates.length < limit) {
      candidates = this.docsForPathCounts(counts, Math.max(1, targetMatches - 1), limit);
    }

    return candidates.slice(0, Math.max(limit * 8, this.CANDIDATE_LIMIT));
  }

  private shouldUseSubstringCandidateFallback(queryTerms: QueryTerm[], phrase: string, candidateCount: number): boolean {
    if (!phrase) return false;
    if (candidateCount === 0 && (/[^\x00-\x7F]/.test(phrase) || this.tokenizeSearchText(phrase).size === 0)) {
      return true;
    }
    return queryTerms.some((term) => this.needsSubstringFallback(term.value) && this.pathsForQueryTerm(term).size === 0);
  }

  private needsSubstringFallback(value: string): boolean {
    if (!value) return false;
    return /[^\x00-\x7F]/.test(value) || this.tokenizeSearchText(value).size === 0;
  }

  private collectSubstringCandidateDocs(terms: string[], phrase: string, limit: number): IndexedDocument[] {
    const matches: IndexedDocument[] = [];
    const cap = Math.max(limit * 8, this.CANDIDATE_LIMIT);
    const searchableTerms = terms.filter(Boolean);

    for (const doc of this.index.values()) {
      if (
        this.documentContainsSubstring(doc, phrase) ||
        searchableTerms.some((term) => this.documentContainsSubstring(doc, term))
      ) {
        matches.push(doc);
        if (matches.length >= cap) break;
      }
    }

    return matches;
  }

  private documentContainsSubstring(doc: IndexedDocument, value: string): boolean {
    if (!value) return false;
    return doc.lowerTitle.includes(value) || doc.lowerPath.includes(value) || doc.body.includes(value);
  }

  private runMetadataSearch(terms: string[], phrase: string, limit: number, sort: SortMode): SearchHit[] {
    const queryTerms = terms.map((value) => ({
      value,
      exact: new Set([value]),
      prefix: new Set<string>(),
      fuzzy: new Set<string>(),
    }));

    const hits = this.getEligibleFiles()
      .map((file) => this.scoreMetadataFile(file, queryTerms, phrase))
      .filter((hit): hit is SearchHit => hit !== null)
      .sort((a, b) => b.score - a.score || (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, limit);

    if (sort === "recency") {
      hits.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || b.score - a.score);
    }

    return hits;
  }

  private scoreMetadataFile(file: TFile, queryTerms: QueryTerm[], phrase: string): SearchHit | null {
    const title = file.basename;
    const path = file.path;
    const metadata = this.getMetadataTokenSnapshot(file);
    const doc: IndexedDocument = {
      path,
      title,
      lowerTitle: metadata.lowerTitle,
      lowerPath: metadata.lowerPath,
      titleTokens: metadata.titleTokens,
      pathTokens: metadata.pathTokens,
      bodyTokens: new Set(),
      tokens: new Set(),
      body: "",
      rawBody: "",
      preview: "",
      mtime: file.stat?.mtime || 0,
      size: file.stat?.size || 0,
    };
    const metadataScore = this.scoreMetadata(doc, queryTerms, phrase);
    if (metadataScore <= 0) return null;

    const maxPossible = Math.max(24, queryTerms.length * 20 + 24);
    const score = Math.min(1, metadataScore / maxPossible);
    return {
      path,
      title,
      score,
      lexScore: score,
      origin: "lexical",
      updatedAt: file.stat?.mtime || 0,
      size: file.stat?.size || 0,
    };
  }

  private scoreMetadata(doc: IndexedDocument, queryTerms: QueryTerm[], phrase: string): number {
    if (queryTerms.length === 0) return 0;
    let score = 0;
    let matchedTerms = 0;

    for (const term of queryTerms) {
      const value = term.value;
      if (doc.lowerTitle === value) {
        score += 20;
        matchedTerms += 1;
        continue;
      }
      if (doc.lowerTitle.includes(value)) {
        score += 14;
        matchedTerms += 1;
        continue;
      }
      if (doc.lowerPath.includes(value)) {
        score += 8;
        matchedTerms += 1;
        continue;
      }

      const relatedTitle = value.length >= 3
        ? Array.from(doc.titleTokens).some((token) => {
          if (token.startsWith(value) || value.startsWith(token)) return true;
          if (value.length < 5) return false;
          const fuzzyScore = fuzzyMatchScore(value, token);
          return fuzzyScore !== null && fuzzyScore <= Math.max(2, Math.floor(value.length * 0.45));
        })
        : false;
      if (relatedTitle) {
        score += 9;
        matchedTerms += 1;
      }
    }

    let phraseMatched = false;
    if (phrase) {
      if (doc.lowerTitle.includes(phrase)) {
        score += 24;
        phraseMatched = true;
      }
      if (doc.lowerPath.includes(phrase)) {
        score += 10;
        phraseMatched = true;
      }
    }

    if (matchedTerms === 0 && !phraseMatched) return 0;
    score += (matchedTerms / queryTerms.length) * 10;
    score += this.computeRecencyBoost(doc.mtime) * 0.15;
    return score;
  }

  private pathsForQueryTerm(term: QueryTerm): Set<string> {
    const paths = new Set<string>();
    const add = (token: string) => {
      const tokenPaths = this.tokenIndex.get(token);
      if (!tokenPaths) return;
      for (const path of tokenPaths) {
        paths.add(path);
      }
    };

    term.exact.forEach(add);
    term.prefix.forEach(add);
    term.fuzzy.forEach(add);
    return paths;
  }

  private docsForPathCounts(counts: Map<string, number>, minCount: number, limit: number): IndexedDocument[] {
    return Array.from(counts.entries())
      .filter(([, count]) => count >= minCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(limit * 8, this.CANDIDATE_LIMIT))
      .map(([path]) => this.index.get(path))
      .filter((doc): doc is IndexedDocument => doc !== undefined);
  }

  private hasAny(tokens: Set<string>, candidates: Set<string>): boolean {
    for (const candidate of candidates) {
      if (tokens.has(candidate)) return true;
    }
    return false;
  }

  private extractExcerpt(doc: IndexedDocument, terms: string[], phrase: string): string {
    const source = doc.rawBody || doc.preview;
    if (!source) return doc.preview;

    const lower = source.toLowerCase();
    let bestIdx = -1;
    let targetTerm = terms[0];

    for (const term of terms) {
      const idx = lower.indexOf(term);
      if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
        bestIdx = idx;
        targetTerm = term;
      }
    }

    if (bestIdx === -1 && phrase) {
      bestIdx = lower.indexOf(phrase);
      targetTerm = phrase;
    }

    if (bestIdx === -1) {
      return doc.preview;
    }

    const contextRadius = 90;
    const start = Math.max(0, bestIdx - contextRadius);
    const end = Math.min(source.length, bestIdx + targetTerm.length + contextRadius);
    const slice = source.slice(start, end).trim();
    const prefix = start > 0 ? "..." : "";
    const suffix = end < source.length ? "..." : "";
    return `${prefix}${slice}${suffix}`;
  }

  private async runSemanticSearch(query: string, limit: number, signal?: AbortSignal): Promise<SearchHit[]> {
    try {
      const manager = this.getExistingEmbeddingsManager();
      if (!manager || signal?.aborted) return [];
      const semanticPromise = (async () => {
        if (typeof manager.awaitReady === "function") {
          await manager.awaitReady();
        }
        if (signal?.aborted) return [];
        const rawResults = await manager.searchSimilar(query, limit, signal);
        if (signal?.aborted) return [];
        return rawResults
          .map((item) => {
            const file = this.app.vault.getAbstractFileByPath(item.path);
            if (!(file instanceof TFile) || !this.isEligible(file)) return null;
            const score = Math.max(0, Math.min(1, item.score ?? 0));
            return {
              path: item.path,
              title: this.extractTitle(item.path, item?.metadata?.title),
              excerpt: item?.metadata?.excerpt,
              score,
              semScore: score,
              origin: "semantic",
              updatedAt: item?.metadata?.lastModified ?? file.stat?.mtime ?? 0,
              size: file.stat?.size || 0,
            } as SearchHit;
          })
          .filter((hit: SearchHit | null): hit is SearchHit => hit !== null);
      })();

      // Avoid long stalls; apply a timeout without leaking a dangling timer.
      return await new Promise<SearchHit[]>((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          window.clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        };
        const finish = (results: SearchHit[]) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(results);
        };
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };
        const onAbort = () => finish([]);
        const timer = window.setTimeout(() => finish([]), this.SEMANTIC_TIMEOUT_MS);
        signal?.addEventListener("abort", onAbort, { once: true });
        semanticPromise.then(
          (results) => finish(results),
          (error) => fail(error)
        );
      });
    } catch {
      return [];
    }
  }

  private shouldUseEmbeddings(mode: SearchMode, indicator: EmbeddingsIndicator, terms: string[]): boolean {
    if (mode === "lexical") return false;
    if (!indicator.enabled || !indicator.ready || !indicator.available) return false;
    if (mode === "semantic") return true;
    if (terms.length === 0) return false;

    const total = indicator.total ?? 0;
    const processed = indicator.processed ?? 0;
    if (total <= 0) return indicator.available;

    return processed / total >= 0.75;
  }

  private mergeResults(lexical: SearchHit[], semantic: SearchHit[], limit: number, mode: SearchMode): SearchHit[] {
    const K = 60;
    const entries = new Map<string, { lex?: SearchHit; sem?: SearchHit; rrfLex: number; rrfSem: number }>();

    lexical.forEach((hit, idx) => {
      const entry = entries.get(hit.path) ?? { rrfLex: 0, rrfSem: 0 };
      entry.lex = hit;
      entry.rrfLex += 1 / (K + idx + 1);
      entries.set(hit.path, entry);
    });

    semantic.forEach((hit, idx) => {
      const entry = entries.get(hit.path) ?? { rrfLex: 0, rrfSem: 0 };
      entry.sem = hit;
      entry.rrfSem += 1 / (K + idx + 1);
      entries.set(hit.path, entry);
    });

    const merged: SearchHit[] = [];

    for (const [path, entry] of entries.entries()) {
      const lexScore = entry.lex?.lexScore ?? 0;
      const semScore = entry.sem?.semScore ?? 0;
      const rrfBoost = entry.rrfLex + entry.rrfSem;

      let finalScore = lexScore;
      let origin: SearchHit["origin"] = "lexical";

      if (entry.lex && entry.sem) {
        finalScore = Math.min(1, 0.55 * lexScore + 0.35 * semScore + 0.10 * rrfBoost);
        origin = "blend";
      } else if (entry.sem && !entry.lex) {
        finalScore = Math.min(1, semScore + 0.25 * rrfBoost);
        origin = "semantic";
      }

      const target = entry.lex ?? entry.sem!;
      merged.push({
        ...target,
        origin,
        score: finalScore,
        lexScore: entry.lex?.lexScore,
        semScore: entry.sem?.semScore,
      });
    }

    merged.sort((a, b) => b.score - a.score || (b.updatedAt || 0) - (a.updatedAt || 0));

    const sliced = merged.slice(0, limit);

    return sliced;
  }

  public getEmbeddingsIndicator(): EmbeddingsIndicator {
    const enabled = this.plugin.settings.embeddingsEnabled === true;
    if (!enabled) {
      return { enabled: false, ready: false, available: false, reason: "Embeddings disabled in settings" };
    }

    try {
      const manager = this.getExistingEmbeddingsManager();
      if (!manager) {
        return { enabled, ready: false, available: false, reason: "Embeddings not initialized" };
      }
      const ready = typeof manager.isReady === "function" ? manager.isReady() : true;
      const stats = typeof manager.getStats === "function" ? manager.getStats() : { total: 0, processed: 0, present: 0, needsProcessing: 0 };
      const available = typeof manager.hasAnyEmbeddings === "function" ? manager.hasAnyEmbeddings() : (stats.present ?? 0) > 0;

      return {
        enabled,
        ready,
        available,
        processed: stats.processed ?? stats.present ?? 0,
        total: stats.total,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Embeddings unavailable";
      return { enabled, ready: false, available: false, reason: message };
    }
  }

  private getExistingEmbeddingsManager(): SearchableEmbeddingsManager | null {
    const manager = (this.plugin as { embeddingsManager?: SearchableEmbeddingsManager }).embeddingsManager;
    return manager && typeof manager.searchSimilar === "function" ? manager : null;
  }

  /**
   * Invoke the plugin's lazy embeddings-manager factory if it exists. Used for
   * explicit semantic searches so a missing manager doesn't silently degrade to
   * lexical-only results. Errors (missing license, misconfigured provider) are
   * swallowed because the subsequent indicator check will report them.
   */
  private ensureEmbeddingsManager(): void {
    const plugin = this.plugin as {
      getOrCreateEmbeddingsManager?: () => SearchableEmbeddingsManager;
    };
    if (typeof plugin.getOrCreateEmbeddingsManager !== "function") return;
    try {
      plugin.getOrCreateEmbeddingsManager();
    } catch {
      // Bootstrap failures are surfaced through the embeddings indicator.
    }
  }

  private extractTitle(path: string, fallback?: string | null): string {
    if (fallback && fallback.trim().length > 0) return fallback.trim();
    const base = path.substring(path.lastIndexOf("/") + 1);
    return base.replace(/\.md$/i, "");
  }

  private async runLimited(
    tasks: Array<() => Promise<void>>,
    concurrency: number,
    yieldEvery = 0
  ): Promise<void> {
    let idx = 0;
    let completed = 0;
    const runners = new Array(Math.min(concurrency, tasks.length)).fill(null).map(async () => {
      while (idx < tasks.length) {
        const current = idx++;
        await tasks[current]();
        completed += 1;
        if (yieldEvery > 0 && completed % yieldEvery === 0) {
          await this.yieldToMainThread();
        }
      }
    });
    await Promise.all(runners);
  }

  private yieldToMainThread(): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}
