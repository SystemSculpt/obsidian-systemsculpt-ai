import { App, EventRef, TFile } from "obsidian";
import SystemSculptPlugin from "../../main";
import { shouldExcludeFromSearch, fuzzyMatchScore } from "../../mcp-tools/filesystem/utils";
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
  body: string; // truncated, lowercased content (frontmatter stripped)
  rawBody: string; // truncated, original casing for excerpts
  preview: string; // short excerpt for list view
  mtime: number;
  size: number;
}

export class SystemSculptSearchEngine {
  private app: App;
  private plugin: SystemSculptPlugin;
  private index: Map<string, IndexedDocument> = new Map();
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
    const indexStart = performance.now();
    await this.ensureIndex();
    await this.refreshDirtyIndex();
    const indexMs = performance.now() - indexStart;
    this.lastLexicalInspect = 0;

    const normalizedQuery = query.trim().toLowerCase();
    const terms = normalizedQuery.split(/\s+/).filter(Boolean);
    const phrase = normalizedQuery;

    if (terms.length === 0) {
      const recents = await this.getRecent(limit);
      return {
        results: recents,
        stats: {
          totalMs: performance.now() - searchStart,
          indexMs,
          indexedCount: this.index.size,
          inspectedCount: 0,
          mode,
          usedEmbeddings: false,
        },
        embeddings: this.getEmbeddingsIndicator(),
      };
    }

    const lexStart = performance.now();
    const lexicalHits = this.runLexicalSearch(terms, phrase, limit, sort);
    const lexMs = performance.now() - lexStart;

    let semanticHits: SearchHit[] = [];
    let semMs: number | undefined;
    let usedEmbeddings = false;

    const embeddingsIndicator = this.getEmbeddingsIndicator();

    if (mode !== "lexical" && embeddingsIndicator.enabled && embeddingsIndicator.ready && embeddingsIndicator.available) {
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
      },
      embeddings: embeddingsIndicator,
    };
  }

  /**
   * Recent files snapshot for empty queries
   */
  async getRecent(limit = 25): Promise<SearchHit[]> {
    await this.ensureIndex();
    await this.refreshDirtyIndex();

    const docs = Array.from(this.index.values())
      .sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
      .slice(0, limit);

    return docs.map((doc) => ({
      path: doc.path,
      title: doc.title,
      excerpt: doc.preview,
      score: 0.5,
      origin: "recent",
      updatedAt: doc.mtime,
      size: doc.size,
    }));
  }

  destroy(): void {
    this.eventRefs.forEach((ref) => this.app.vault.offref(ref));
    this.eventRefs = [];
    this.index.clear();
    this.dirtyPaths.clear();
    this.indexPromise = null;
  }

  private registerVaultWatchers() {
    this.eventRefs.push(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && this.isEligible(file)) {
          this.dirtyPaths.add(file.path);
        }
      })
    );

    this.eventRefs.push(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile && this.isEligible(file)) {
          this.dirtyPaths.add(file.path);
        }
      })
    );

    this.eventRefs.push(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) {
          this.index.delete(file.path);
          this.dirtyPaths.delete(file.path);
        }
      })
    );

    this.eventRefs.push(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFile)) return;
        this.index.delete(oldPath);
        if (this.isEligible(file)) {
          this.dirtyPaths.add(file.path);
        }
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

    await this.indexPromise;
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
    const tasks = files.map((file) => async () => {
      try {
        const content = await this.safeRead(file);
        const extracted = this.getIndexText(file, content);
        const rawBody = extracted.slice(0, this.MAX_INDEX_CHARS);
        const body = rawBody.toLowerCase();
        const preview = this.buildPreviewFromText(extracted);

        const doc: IndexedDocument = {
          path: file.path,
          title: file.basename,
          lowerTitle: file.basename.toLowerCase(),
          lowerPath: file.path.toLowerCase(),
          body,
          rawBody,
          preview,
          mtime: file.stat?.mtime || 0,
          size: file.stat?.size || 0,
        };

        this.index.set(file.path, doc);
      } catch {
        // Skip failed file
      }
    });

    await this.runLimited(tasks, this.CONTENT_CONCURRENCY);

    if (!incremental) {
      // Remove any stale paths not present anymore
      const validPaths = new Set(files.map((f) => f.path));
      for (const key of Array.from(this.index.keys())) {
        if (!validPaths.has(key) && !this.dirtyPaths.has(key)) {
          this.index.delete(key);
        }
      }
    }
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
    const docs = Array.from(this.index.values());
    const candidates = docs.filter((doc) => {
      if (phrase && doc.body.includes(phrase)) return true;
      return terms.some((t) => doc.lowerTitle.includes(t) || doc.lowerPath.includes(t) || doc.body.includes(t));
    });

    this.lastLexicalInspect = candidates.length;

    // Fallback to top name matches if nothing matched the body/title/path
    const pool = candidates.length > 0 ? candidates : docs.slice(0, Math.min(this.CANDIDATE_LIMIT, docs.length));

    const scored = pool
      .map((doc) => this.scoreDocument(doc, terms, phrase))
      .filter((r): r is SearchHit => r !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit * 2); // keep extra for merge step

    if (sort === "recency") {
      scored.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || b.score - a.score);
    }

    return scored;
  }

  private fastNameScore(doc: IndexedDocument, query: string): number {
    if (!query) return 0;
    const lc = query.toLowerCase();
    let score = 0;
    if (doc.lowerTitle.includes(lc)) score += 18;
    if (doc.lowerPath.includes(lc)) score += 8;
    const fuzzy = fuzzyMatchScore(lc, doc.lowerTitle);
    if (fuzzy !== null) {
      score += Math.max(0, 12 - Math.min(fuzzy, 24));
    }
    return score;
  }

  private scoreDocument(doc: IndexedDocument, terms: string[], phrase: string): SearchHit | null {
    if (terms.length === 0) return null;
    let total = 0;
    let matchedTerms = 0;

    for (const term of terms) {
      const inTitle = doc.lowerTitle.includes(term);
      const inPath = doc.lowerPath.includes(term);
      const inBody = doc.body.includes(term);

      if (inTitle) total += 10;
      if (inPath) total += 5;
      if (inBody) total += 4;
      if (inTitle || inBody) matchedTerms += 1;
    }

    const phraseHit = phrase && doc.body.includes(phrase) ? 10 : 0;
    total += phraseHit;

    const coverageBonus = matchedTerms > 0 ? (matchedTerms / terms.length) * 10 : 0;
    total += coverageBonus;

    total += this.computeRecencyBoost(doc.mtime);

    const maxPossible = terms.length * 19 + 16;
    const score = Math.min(1, total / maxPossible);

    if (score <= 0) return null;

    return {
      path: doc.path,
      title: doc.title,
      excerpt: this.extractExcerpt(doc, terms, phrase),
      score,
      lexScore: score,
      origin: "lexical",
      updatedAt: doc.mtime,
      size: doc.size,
    };
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
