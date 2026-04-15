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

export class SystemSculptSearchEngine {
  private app: App;
  private plugin: SystemSculptPlugin;
  private index: Map<string, IndexedDocument> = new Map();
  private tokenIndex: Map<string, Set<string>> = new Map();
  private tokenVocabulary: Set<string> = new Set();
  private recentHitsCache: SearchHit[] | null = null;
  private indexPromise: Promise<void> | null = null;
  private dirtyPaths: Set<string> = new Set();
  private eventRefs: EventRef[] = [];
  private readonly INDEXABLE_EXTENSIONS = new Set(["md", "markdown", "canvas"]);
  private readonly MAX_INDEX_CHARS = 6500;
  private readonly PREVIEW_CHARS = 240;
  private readonly CANDIDATE_LIMIT = 320;
  private readonly CONTENT_CONCURRENCY = 10;
  private readonly SEMANTIC_TIMEOUT_MS = 1500;
  private lastLexicalInspect = 0;

  constructor(app: App, plugin: SystemSculptPlugin) {
    this.app = app;
    this.plugin = plugin;
    this.registerVaultWatchers();
  }

  /**
   * Run a search across the vault
   */
  async search(query: string, options?: { mode?: SearchMode; sort?: SortMode; limit?: number }): Promise<SearchResponse> {
    const mode: SearchMode = options?.mode ?? "smart";
    const sort: SortMode = options?.sort ?? "relevance";
    const limit = options?.limit ?? 80;

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

    const indexStart = performance.now();
    await this.ensureIndex();
    await this.refreshDirtyIndex();
    const indexMs = performance.now() - indexStart;
    this.lastLexicalInspect = 0;

    const lexStart = performance.now();
    const lexicalHits = this.runLexicalSearch(terms, phrase, limit, sort);
    const lexMs = performance.now() - lexStart;

    let semanticHits: SearchHit[] = [];
    let semMs: number | undefined;
    let usedEmbeddings = false;

    const embeddingsIndicator = this.getEmbeddingsIndicator();
    const embeddingsEligible = this.shouldUseEmbeddings(mode, embeddingsIndicator, terms);

    if (embeddingsEligible) {
      const semStart = performance.now();
      semanticHits = await this.runSemanticSearch(query, limit);
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
    if (!this.recentHitsCache) {
      this.recentHitsCache = this.getEligibleFiles()
        .sort((a, b) => (b.stat?.mtime || 0) - (a.stat?.mtime || 0))
        .map((file) => {
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
        });
    }

    return this.recentHitsCache.slice(0, limit);
  }

  async warmIndex(): Promise<void> {
    try {
      await this.ensureIndex();
    } catch {
      // Search can recover on the next explicit query.
    }
  }

  destroy(): void {
    this.eventRefs.forEach((ref) => this.app.vault.offref(ref));
    this.eventRefs = [];
    this.index.clear();
    this.tokenIndex.clear();
    this.tokenVocabulary.clear();
    this.recentHitsCache = null;
    this.dirtyPaths.clear();
    this.indexPromise = null;
  }

  private registerVaultWatchers() {
    this.eventRefs.push(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && this.isEligible(file)) {
          this.dirtyPaths.add(file.path);
          this.recentHitsCache = null;
        }
      })
    );

    this.eventRefs.push(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile && this.isEligible(file)) {
          this.dirtyPaths.add(file.path);
          this.recentHitsCache = null;
        }
      })
    );

    this.eventRefs.push(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) {
          const existing = this.index.get(file.path);
          if (existing) {
            this.removeFromTokenIndex(existing);
          }
          this.index.delete(file.path);
          this.dirtyPaths.delete(file.path);
          this.recentHitsCache = null;
        }
      })
    );

    this.eventRefs.push(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFile)) return;
        const existing = this.index.get(oldPath);
        if (existing) {
          this.removeFromTokenIndex(existing);
        }
        this.index.delete(oldPath);
        if (this.isEligible(file)) {
          this.dirtyPaths.add(file.path);
        }
        this.recentHitsCache = null;
      })
    );
  }

  private async ensureIndex(): Promise<void> {
    if (this.indexPromise) {
      await this.indexPromise;
      return;
    }

    this.indexPromise = (async () => {
      const files = this.getEligibleFiles();
      await this.buildIndex(files);
    })();

    try {
      await this.indexPromise;
    } catch (error) {
      this.indexPromise = null;
      throw error;
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

    await this.buildIndex(filesToRefresh, true);
  }

  private async buildIndex(files: TFile[], incremental = false): Promise<void> {
    if (!incremental) {
      this.index.clear();
      this.tokenIndex.clear();
      this.tokenVocabulary.clear();
      this.recentHitsCache = null;
    }

    const tasks = files.map((file) => async () => {
      try {
        const content = await this.safeRead(file);
        const extracted = this.getIndexText(file, content);
        const rawBody = extracted.slice(0, this.MAX_INDEX_CHARS);
        const body = rawBody.toLowerCase();
        const preview = this.buildPreviewFromText(extracted);
        const titleTokens = this.tokenizeSearchText(file.basename);
        const pathTokens = this.tokenizeSearchText(file.path);
        const bodyTokens = this.tokenizeSearchText(body);
        const tokens = new Set([...titleTokens, ...pathTokens, ...bodyTokens]);

        const doc: IndexedDocument = {
          path: file.path,
          title: file.basename,
          lowerTitle: file.basename.toLowerCase(),
          lowerPath: file.path.toLowerCase(),
          titleTokens,
          pathTokens,
          bodyTokens,
          tokens,
          body,
          rawBody,
          preview,
          mtime: file.stat?.mtime || 0,
          size: file.stat?.size || 0,
        };

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

    await this.runLimited(tasks, this.CONTENT_CONCURRENCY);
    this.recentHitsCache = null;
  }

  private async safeRead(file: TFile): Promise<string> {
    try {
      return await this.app.vault.cachedRead(file);
    } catch {
      return "";
    }
  }

  private getEligibleFiles(): TFile[] {
    const cached = this.plugin.vaultFileCache?.getAllFiles?.();
    const files = Array.isArray(cached) ? cached : this.app.vault.getFiles();
    return files.filter((f) => this.isEligible(f));
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

    this.lastLexicalInspect = candidates.length;

    // Fallback to the first indexed docs if no indexed token can match the query at all.
    const pool = candidates.length > 0
      ? candidates
      : Array.from(this.index.values()).slice(0, Math.min(this.CANDIDATE_LIMIT, this.index.size));

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

    for (const term of queryTerms) {
      const fieldScore = this.scoreTermInDocument(doc, term);
      if (fieldScore > 0) {
        total += fieldScore;
        matchedTerms += 1;
      }
    }

    if (phrase) {
      if (doc.lowerTitle.includes(phrase)) total += 20;
      if (doc.lowerPath.includes(phrase)) total += 10;
      if (doc.body.includes(phrase)) total += 14;
    }

    const coverageRatio = matchedTerms / queryTerms.length;
    const coverageBonus = matchedTerms > 0 ? coverageRatio * 16 : 0;
    total += coverageBonus;

    total += this.computeRecencyBoost(doc.mtime) * Math.max(0.25, coverageRatio);

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
      .match(/[a-z0-9]+/g);
    if (!tokens) return new Set();
    return new Set(tokens.filter((token) => token.length > 1));
  }

  private addToTokenIndex(doc: IndexedDocument): void {
    for (const token of doc.tokens) {
      this.tokenVocabulary.add(token);
      let paths = this.tokenIndex.get(token);
      if (!paths) {
        paths = new Set();
        this.tokenIndex.set(token, paths);
      }
      paths.add(doc.path);
    }
  }

  private removeFromTokenIndex(doc: IndexedDocument): void {
    for (const token of doc.tokens) {
      const paths = this.tokenIndex.get(token);
      if (!paths) continue;
      paths.delete(doc.path);
      if (paths.size === 0) {
        this.tokenIndex.delete(token);
        this.tokenVocabulary.delete(token);
      }
    }
  }

  private buildQueryTerms(terms: string[]): QueryTerm[] {
    return terms.map((value) => {
      const exact = new Set<string>();
      const prefix = new Set<string>();
      const fuzzy = new Set<string>();

      if (this.tokenIndex.has(value)) {
        exact.add(value);
      }

      if (value.length >= 3) {
        for (const token of this.tokenVocabulary) {
          if (token === value) continue;
          if (token.startsWith(value) || value.startsWith(token)) {
            prefix.add(token);
            continue;
          }

          if (value.length >= 5) {
            const fuzzyScore = fuzzyMatchScore(value, token);
            const maxGap = Math.max(2, Math.floor(value.length * 0.45));
            if (fuzzyScore !== null && fuzzyScore <= maxGap) {
              fuzzy.add(token);
            }
          }
        }
      }

      return { value, exact, prefix, fuzzy };
    });
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

  private async runSemanticSearch(query: string, limit: number): Promise<SearchHit[]> {
    try {
      const manager = this.plugin.getOrCreateEmbeddingsManager();
      const semanticPromise = (async () => {
        // @ts-ignore awaitReady is public but not in types
        if (typeof (manager as any).awaitReady === "function") {
          await (manager as any).awaitReady();
        }
        const rawResults = await manager.searchSimilar(query, limit);
        return rawResults.map((item: any) => ({
          path: item.path,
          title: this.extractTitle(item.path, item?.metadata?.title),
          excerpt: item?.metadata?.excerpt,
          score: Math.max(0, Math.min(1, item.score ?? 0)),
          semScore: Math.max(0, Math.min(1, item.score ?? 0)),
          origin: "semantic",
          updatedAt: item?.metadata?.lastModified ?? 0,
        } as SearchHit));
      })();

      // Avoid long stalls; apply a timeout without leaking a dangling timer.
      return await new Promise<SearchHit[]>((resolve, reject) => {
        const timer = window.setTimeout(() => resolve([]), this.SEMANTIC_TIMEOUT_MS);
        semanticPromise.then(
          (results) => {
            window.clearTimeout(timer);
            resolve(results);
          },
          (error) => {
            window.clearTimeout(timer);
            reject(error);
          }
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
      const manager = this.plugin.getOrCreateEmbeddingsManager();
      const ready = typeof (manager as any).isReady === "function" ? (manager as any).isReady() : true;
      const stats = typeof manager.getStats === "function" ? manager.getStats() : { total: 0, processed: 0, present: 0, needsProcessing: 0 };
      const available = typeof (manager as any).hasAnyEmbeddings === "function" ? (manager as any).hasAnyEmbeddings() : stats.present > 0;

      return {
        enabled,
        ready,
        available,
        processed: stats.present,
        total: stats.total,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Embeddings unavailable";
      return { enabled, ready: false, available: false, reason: message };
    }
  }

  private extractTitle(path: string, fallback?: string | null): string {
    if (fallback && fallback.trim().length > 0) return fallback.trim();
    const base = path.substring(path.lastIndexOf("/") + 1);
    return base.replace(/\.md$/i, "");
  }

  private async runLimited(tasks: Array<() => Promise<void>>, concurrency: number): Promise<void> {
    let idx = 0;
    const runners = new Array(Math.min(concurrency, tasks.length)).fill(null).map(async () => {
      while (idx < tasks.length) {
        const current = idx++;
        await tasks[current]();
      }
    });
    await Promise.all(runners);
  }
}
