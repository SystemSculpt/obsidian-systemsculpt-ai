import { App, EventRef, TFile } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { fuzzyMatchScore } from "../../tools/vault/searchUtils";
import { containsNonAscii } from "../../utils/characterValidation";
import { extractCanvasText } from "./canvasTextExtractor";
import { extractStudioText } from "./studioTextExtractor";
import { resolveStudioEntry } from "../../studio/StudioEntry";
import { STUDIO_PROJECT_EXTENSION } from "../../studio/types";
import { searchVaultExclusions, type VaultExclusions } from "./VaultExclusions";
import {
  BODY_FIELD,
  copyFlat,
  PATH_FIELD,
  SearchTextIndex,
  TITLE_FIELD,
  type IndexedNote,
  type NoteTokens,
} from "./SearchTextIndex";

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

interface SearchStats {
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

/** A note's indexed text, read again for one search. */
interface NoteText {
  /** Truncated, lowercased content (frontmatter stripped), as indexed. */
  body: string;
  /** Truncated, original casing for excerpts. */
  raw: string;
}

interface QueryTerm {
  value: string;
  exact: Set<string>;
  prefix: Set<string>;
  fuzzy: Set<string>;
}

/** The notes a query term's tokens reach, with the fields each was found in. */
interface TermMatches {
  /** Matching notes in posting order: exact tokens first, then prefix, then fuzzy. */
  docs: number[];
  exact: Uint8Array;
  prefix: Uint8Array;
  fuzzy: Uint8Array;
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
  /** Changes whenever indexed vectors change. */
  getIndexRevision?: () => number;
  getLifecycleSnapshot?: () => { updatedAt: number };
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
  private textIndex = new SearchTextIndex();
  private eligibleFilesCache: TFile[] | null = null;
  private eligibleFilesCacheSignature: string | null = null;
  private metadataTokenCache: Map<string, MetadataTokenSnapshot> = new Map();
  private recentHitsCache: { limit: number; hits: SearchHit[] } | null = null;
  private recentPreviewCache: Map<string, CachedPreview> = new Map();
  private studioDocuments = new Map<string, { text: string; mtime: number; size: number }>();
  private studioGeneration = 0;
  private indexPromise: Promise<void> | null = null;
  private contentIndexReady = false;
  private indexGeneration = 0;
  private scheduledIndexHandle: number | null = null;
  private dirtyPaths: Set<string> = new Set();
  private refreshQueue: Promise<void> = Promise.resolve();
  private holders = 0;
  private idleReleaseHandle: number | null = null;
  private eventRefs: EventRef[] = [];
  private workspaceEventRefs: EventRef[] = [];
  private readonly INDEXABLE_EXTENSIONS = new Set(["md", "markdown", "canvas", STUDIO_PROJECT_EXTENSION.slice(1)]);
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
  /** Smart mode skips semantic search for one- and two-character prefixes. */
  private readonly MIN_SEMANTIC_QUERY_CHARS = 3;
  /** How long the index outlives the last open search before it is freed. */
  private readonly IDLE_RELEASE_MS = 5 * 60_000;
  private embeddingsIndicatorCache: { key: string; indicator: EmbeddingsIndicator } | null = null;
  private readonly UNICODE_TOKEN_PATTERN = /[\p{L}\p{N}\p{M}]+/gu;
  private lastLexicalInspect = 0;

  constructor(app: App, plugin: SystemSculptPlugin) {
    this.app = app;
    this.plugin = plugin;
    this.registerVaultWatchers();
  }

  /**
   * Run a search across the vault. `semantic: false` keeps a smart search
   * lexical-only; the search modal uses it for fast per-keystroke results
   * and adds semantic hits once typing pauses. The semantic leg runs until it
   * answers or `signal` aborts: the caller already has word results on
   * screen, so a slow managed query is worth waiting for.
   */
  async search(
    query: string,
    options?: { mode?: SearchMode; sort?: SortMode; limit?: number; signal?: AbortSignal; semantic?: boolean },
  ): Promise<SearchResponse> {
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
          indexedCount: this.textIndex.size,
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

    this.refreshEligibilityIfChanged();
    await this.prepareStudioDocuments();
    if (signal?.aborted) {
      throw new DOMException("Search aborted", "AbortError");
    }

    if (mode === "smart" && !this.contentIndexReady) {
      this.refreshEligibilityIfChanged();
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
          indexedCount: this.textIndex.size,
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
    // One index snapshot for the whole search: a commit by an overlapping
    // search builds a new index rather than renumbering this one.
    const bodies = new NoteBodyMatcher(this.textIndex, (note) => this.readNoteText(note));
    const lexicalHits = await this.runLexicalSearch(terms, phrase, limit, sort, bodies);
    const lexMs = performance.now() - lexStart;

    let semanticHits: SearchHit[] = [];
    let semMs: number | undefined;
    let usedEmbeddings = false;

    let embeddingsIndicator = this.getEmbeddingsIndicator();
    // Smart and semantic searches should lazily bootstrap the embeddings
    // manager so a fresh session (or delayed autostart / auto-processing off)
    // can still produce semantic hits instead of silently falling back to
    // lexical-only. Lexical-only searches intentionally skip the bootstrap.
    if (mode !== "lexical" && embeddingsIndicator.enabled && !this.getExistingEmbeddingsManager()) {
      this.ensureEmbeddingsManager();
      embeddingsIndicator = this.getEmbeddingsIndicator();
    }
    const embeddingsEligible = options?.semantic !== false
      && this.shouldUseEmbeddings(mode, embeddingsIndicator, terms, normalizedQuery);

    if (embeddingsEligible) {
      const semStart = performance.now();
      semanticHits = await this.runSemanticSearch(query, limit, signal);
      semMs = performance.now() - semStart;
      usedEmbeddings = semanticHits.length > 0;
    } else if (mode === "semantic" && (!embeddingsIndicator.enabled || !embeddingsIndicator.available)) {
      // Explicit semantic request but embeddings not ready; keep usedEmbeddings false and rely on lexical fallback
    }

    const results = this.mergeResults(lexicalHits, semanticHits, limit, sort);
    await this.attachExcerpts(results, terms, phrase, bodies);

    const totalMs = performance.now() - searchStart;

    return {
      results,
      stats: {
        totalMs,
        lexMs,
        semMs,
        indexMs,
        indexedCount: this.textIndex.size,
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
    this.refreshEligibilityIfChanged();
    await this.prepareStudioDocuments();
    // Reuse indexed previews below requires the index to match on-disk state.
    // When the content index is already built, flush any modify/create events
    // that set dirtyPaths so we don't serve stale snippets for modified
    // notes. The modal only hydrates rows that lack an excerpt, so a stale
    // indexed.preview would otherwise persist until the next full search.
    if (this.contentIndexReady) {
      await this.refreshDirtyIndex();
    }
    if (!this.recentHitsCache || this.recentHitsCache.limit < limit) {
      const recentFiles = this.selectRecentFiles(this.getEligibleFiles(), limit);
      this.recentHitsCache = {
        limit,
        hits: recentFiles.map((file) => {
          const indexed = this.textIndex.noteByPath(file.path);
          return {
            path: file.path,
            title: indexed?.title ?? file.basename,
            excerpt: indexed?.preview,
            score: 0.5,
            origin: "recent" as const,
            updatedAt: this.modifiedTime(file),
            size: this.fileSize(file),
          };
        }),
      };
    }

    return this.recentHitsCache.hits.slice(0, limit);
  }

  async getRecentPreviews(paths: string[], limit = 25, signal?: AbortSignal): Promise<Map<string, string>> {
    this.refreshEligibilityIfChanged();
    await this.prepareStudioDocuments();
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

      if (this.fileSize(file) > this.MAX_RECENT_PREVIEW_FILE_BYTES && !this.isStudioFile(file)) {
        return;
      }

      try {
        const content = this.isStudioFile(file) ? "" : await this.safeRead(file);
        if (signal?.aborted) return;
        const preview = copyFlat(this.buildPreviewFromText(this.getIndexText(file, content)));
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

  /**
   * Keeps the content index while a search surface is open. Once the last
   * holder lets go and IDLE_RELEASE_MS pass unused, the index is freed; the
   * next search builds it again, as on first use.
   */
  hold(): () => void {
    this.holders += 1;
    this.clearIdleRelease();
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.holders -= 1;
      if (this.holders > 0) return;
      this.idleReleaseHandle = window.setTimeout(() => {
        this.idleReleaseHandle = null;
        if (this.holders === 0) this.clearIndexes();
      }, this.IDLE_RELEASE_MS);
    };
  }

  private clearIdleRelease(): void {
    if (this.idleReleaseHandle !== null) {
      window.clearTimeout(this.idleReleaseHandle);
      this.idleReleaseHandle = null;
    }
  }

  destroy(): void {
    this.clearIdleRelease();
    this.eventRefs.forEach((ref) => this.app.vault.offref(ref));
    this.eventRefs = [];
    this.workspaceEventRefs.forEach((ref) => {
      this.app.workspace.offref(ref);
    });
    this.workspaceEventRefs = [];
    this.clearIndexes();
  }

  private registerVaultWatchers() {
    this.eventRefs.push(
      this.app.vault.on("modify", (file) => {
        this.invalidateStudioDocuments(file);
        if (file instanceof TFile && this.isEligible(file)) {
          this.dirtyPaths.add(file.path);
          this.recentHitsCache = null;
          this.recentPreviewCache.delete(file.path);
        }
      })
    );

    this.eventRefs.push(
      this.app.vault.on("create", (file) => {
        this.invalidateStudioDocuments(file);
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
        this.invalidateStudioDocuments(file);
        this.eligibleFilesCache = null;
        this.eligibleFilesCacheSignature = null;
        if (file instanceof TFile) {
          this.metadataTokenCache.delete(file.path);
          this.textIndex.remove(file.path);
          this.dirtyPaths.delete(file.path);
          this.recentHitsCache = null;
          this.recentPreviewCache.delete(file.path);
        }
      })
    );

    this.eventRefs.push(
      this.app.vault.on("rename", (file, oldPath) => {
        this.invalidateStudioDocuments(file, oldPath);
        this.eligibleFilesCache = null;
        this.eligibleFilesCacheSignature = null;
        if (!(file instanceof TFile)) return;
        this.metadataTokenCache.delete(oldPath);
        this.metadataTokenCache.delete(file.path);
        this.textIndex.remove(oldPath);
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
        this.app.workspace.on("systemsculpt:settings-updated", (_oldSettings, _newSettings, changedKeys) => {
          if (changedKeys.some(key => [
            "embeddingsExclusions", "chatsDirectory", "savedChatsDirectory",
            "recordingsDirectory", "attachmentsDirectory", "extractionsDirectory",
          ].includes(key))) this.clearIndexes();
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
      await this.prepareStudioDocuments();
      const files = this.getEligibleFiles();
      const built = await this.buildIndex(files, false, generation);
      if (built && generation === this.indexGeneration) {
        this.contentIndexReady = true;
        // Only the title-only search before the index is ready uses these.
        this.metadataTokenCache.clear();
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
    this.textIndex = new SearchTextIndex();
    this.eligibleFilesCache = null;
    this.eligibleFilesCacheSignature = null;
    this.metadataTokenCache.clear();
    this.recentHitsCache = null;
    this.recentPreviewCache.clear();
    this.studioGeneration += 1;
    this.studioDocuments.clear();
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

  /** Applies vault changes to the index, one refresh at a time. */
  private refreshDirtyIndex(): Promise<void> {
    const refresh = this.refreshQueue.then(() => this.applyDirtyPaths());
    this.refreshQueue = refresh.catch(() => undefined);
    return refresh;
  }

  private async applyDirtyPaths(): Promise<void> {
    if (this.dirtyPaths.size > 0) {
      const paths = Array.from(this.dirtyPaths);
      this.dirtyPaths.clear();

      const filesToRefresh = paths
        .map((p) => this.app.vault.getAbstractFileByPath(p))
        .filter((f): f is TFile => f instanceof TFile && this.isEligible(f));

      if (filesToRefresh.length > 0) {
        await this.buildIndex(filesToRefresh, true, this.indexGeneration);
      }
    }
    // Deletes and renames drop notes at once; their postings go here.
    this.textIndex = this.textIndex.commit();
  }

  private async buildIndex(files: TFile[], incremental = false, generation = this.indexGeneration): Promise<boolean> {
    const index = incremental ? this.textIndex : new SearchTextIndex();
    const tasks = files.map((file) => async () => {
      try {
        if (generation !== this.indexGeneration) return;
        const doc = await this.indexFile(file);
        if (!doc || generation !== this.indexGeneration) return;
        index.upsert(doc.note, doc.tokens);
      } catch {
        // Skip failed file
      }
    });

    await this.runLimited(tasks, this.CONTENT_CONCURRENCY, this.INDEX_BUILD_YIELD_EVERY);
    if (generation !== this.indexGeneration) return false;
    this.textIndex = index.commit();
    this.recentHitsCache = null;
    return true;
  }

  /** Tokens and list metadata for one note. Only a short preview of its text is kept. */
  private async indexFile(file: TFile): Promise<{ note: IndexedNote; tokens: NoteTokens } | null> {
    if (this.isStudioFile(file) && !this.studioDocuments.has(file.path)) {
      // A vault event invalidated a source while it was being read. Retry it on
      // the next refresh instead of committing an empty content snapshot.
      this.dirtyPaths.add(file.path);
      return null;
    }
    const content = this.isStudioFile(file) ? "" : await this.safeRead(file);
    const extracted = this.getIndexText(file, content);
    const metadata = this.metadataTokenCache.get(file.path) ?? this.createMetadataTokenSnapshot(file);
    const body = extracted.slice(0, this.MAX_INDEX_CHARS).toLowerCase();

    const tokens: NoteTokens = new Map();
    for (const token of metadata.titleTokens) tokens.set(token, TITLE_FIELD);
    for (const token of metadata.pathTokens) tokens.set(token, (tokens.get(token) ?? 0) | PATH_FIELD);
    // Body tokens keep single-character runs so substring checks can be
    // answered from the index; word matching ignores them, as before.
    for (const token of body.toLowerCase().match(this.UNICODE_TOKEN_PATTERN) ?? []) {
      tokens.set(token, (tokens.get(token) ?? 0) | BODY_FIELD);
    }

    return {
      note: {
        file,
        path: file.path,
        title: file.basename,
        lowerTitle: metadata.lowerTitle,
        lowerPath: metadata.lowerPath,
        preview: copyFlat(this.buildPreviewFromText(extracted)),
        mtime: this.modifiedTime(file),
        size: this.fileSize(file),
      },
      tokens,
    };
  }

  /** The note's indexed text, read again: the index keeps no note bodies. */
  private async readNoteText(note: IndexedNote): Promise<NoteText> {
    const content = this.isStudioFile(note.file) ? "" : await this.safeRead(note.file);
    const extracted = this.getIndexText(note.file, content);
    return {
      body: extracted.slice(0, this.MAX_INDEX_CHARS).toLowerCase(),
      raw: extracted.slice(0, this.MAX_EXCERPT_SOURCE_CHARS),
    };
  }

  private async safeRead(file: TFile): Promise<string> {
    try {
      return await this.app.vault.cachedRead(file);
    } catch {
      return "";
    }
  }

  private isStudioFile(file: TFile): boolean {
    return file.extension.toLowerCase() === STUDIO_PROJECT_EXTENSION.slice(1);
  }

  private modifiedTime(file: TFile): number {
    return this.studioDocuments.get(file.path)?.mtime ?? file.stat?.mtime ?? 0;
  }

  private fileSize(file: TFile): number {
    return this.studioDocuments.get(file.path)?.size ?? file.stat?.size ?? 0;
  }

  /** Resolve stable Studio links before ranking, without building the note index. */
  private async prepareStudioDocuments(): Promise<void> {
    const generation = this.studioGeneration;
    const files = this.getEligibleFiles().filter((file) => this.isStudioFile(file) && !this.studioDocuments.has(file.path));
    const tasks = files.map((file) => async () => {
      let text = "";
      let source = file;
      try {
        const resolved = await resolveStudioEntry({ read: async (path) => {
          const target = this.app.vault.getAbstractFileByPath(path);
          if (!(target instanceof TFile) || searchVaultExclusions(this.plugin).isExcluded(target.path)) {
            throw new Error("Studio search source unavailable");
          }
          return this.app.vault.cachedRead(target);
        } }, file.path);
        const target = this.app.vault.getAbstractFileByPath(resolved.path);
        if (target instanceof TFile) source = target;
        text = extractStudioText(resolved.raw, { maxChars: this.MAX_INDEX_CHARS });
      } catch {
        // Broken entries remain searchable by filename, without indexing raw JSON.
      }
      if (generation !== this.studioGeneration) return;
      this.studioDocuments.set(file.path, {
        text,
        mtime: Math.max(file.stat?.mtime || 0, source.stat?.mtime || 0),
        size: source.stat?.size || 0,
      });
    });
    await this.runLimited(tasks, this.CONTENT_CONCURRENCY, this.INDEX_BUILD_YIELD_EVERY);
  }

  private invalidateStudioDocuments(file: { path: string }, oldPath?: string): void {
    // A projection can change without touching its public entry. Invalidate before
    // filtering out internal Studio files so linked content and recency stay fresh.
    if (![file.path, oldPath].some((path) => path?.toLowerCase().endsWith(STUDIO_PROJECT_EXTENSION))) return;
    for (const entry of this.getEligibleFiles()) {
      if (!this.isStudioFile(entry)) continue;
      this.dirtyPaths.add(entry.path);
      this.recentPreviewCache.delete(entry.path);
    }
    this.studioGeneration += 1;
    this.studioDocuments.clear();
    this.recentHitsCache = null;
  }

  private getEligibleFiles(): TFile[] {
    const exclusions = searchVaultExclusions(this.plugin);
    if (this.eligibleFilesCache && this.eligibleFilesCacheSignature === exclusions.signature) {
      return this.eligibleFilesCache;
    }

    const cached = this.plugin.vaultFileCache?.getAllFilesView?.() ?? this.plugin.vaultFileCache?.getAllFiles?.();
    const files = Array.isArray(cached) ? cached : this.app.vault.getFiles();
    this.eligibleFilesCache = Array.from(files).filter((f) => this.isEligible(f, exclusions));
    this.eligibleFilesCacheSignature = exclusions.signature;
    return this.eligibleFilesCache;
  }

  /**
   * If the exclusion rules changed since the last search, blow away the
   * content/token indexes so the next search sees newly-included files and
   * forgets newly-excluded ones. The shared exclusion signature covers
   * Obsidian's "Excluded files", which change without a plugin settings event.
   * Track the new signature so subsequent changes are still detected — nulling
   * it here previously let the guard short-circuit later edits until an
   * unrelated event repopulated it.
   */
  private refreshEligibilityIfChanged(): void {
    const signature = searchVaultExclusions(this.plugin).signature;
    if (this.eligibleFilesCacheSignature === null || this.eligibleFilesCacheSignature === signature) {
      return;
    }
    this.clearIndexes();
    this.eligibleFilesCacheSignature = signature;
  }

  private getMetadataTokenSnapshot(file: TFile): MetadataTokenSnapshot {
    const cached = this.metadataTokenCache.get(file.path);
    if (cached) return cached;

    const snapshot = this.createMetadataTokenSnapshot(file);
    this.metadataTokenCache.set(file.path, snapshot);
    return snapshot;
  }

  private createMetadataTokenSnapshot(file: TFile): MetadataTokenSnapshot {
    return {
      lowerTitle: file.basename.toLowerCase(),
      lowerPath: file.path.toLowerCase(),
      titleTokens: this.tokenizeSearchText(file.basename),
      pathTokens: this.tokenizeSearchText(file.path),
    };
  }

  private selectRecentFiles(files: TFile[], limit: number): TFile[] {
    if (limit <= 0) return [];
    const top: TFile[] = [];
    for (const file of files) {
      const mtime = this.modifiedTime(file);
      if (top.length === 0) {
        top.push(file);
        continue;
      }

      let insertAt = top.findIndex((candidate) => mtime > this.modifiedTime(candidate));
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
    return `${file.path}:${this.modifiedTime(file)}:${this.fileSize(file)}`;
  }

  private isEligible(file: TFile, exclusions: VaultExclusions = searchVaultExclusions(this.plugin)): boolean {
    if (!this.INDEXABLE_EXTENSIONS.has((file.extension ?? "").toLowerCase())) return false;
    if (this.isStudioFile(file) && (
      file.path.startsWith(".systemsculpt/studio/projects/") ||
      /\.studio\/views\//u.test(file.path) ||
      /\.systemsculpt-assets\//u.test(file.path)
    )) return false;
    return !exclusions.isExcluded(file.path);
  }

  private stripFrontmatter(content: string): string {
    return content.replace(/^---[\s\S]*?---\n/, "");
  }

  private getIndexText(file: TFile, content: string): string {
    const ext = (file.extension ?? "").toLowerCase();
    if (ext === "canvas") {
      return extractCanvasText(content, { maxChars: this.MAX_INDEX_CHARS });
    }
    if (this.isStudioFile(file)) return this.studioDocuments.get(file.path)?.text ?? "";

    return this.stripFrontmatter(content);
  }

  private buildPreviewFromText(text: string): string {
    const trimmed = text.trim();
    if (trimmed.length <= this.PREVIEW_CHARS) return trimmed;
    return `${trimmed.slice(0, this.PREVIEW_CHARS)}...`;
  }

  private async runLexicalSearch(
    terms: string[],
    phrase: string,
    limit: number,
    sort: SortMode,
    bodies: NoteBodyMatcher,
  ): Promise<SearchHit[]> {
    const index = bodies.index;
    const queryTerms = this.buildQueryTerms(index, terms);
    const matches = queryTerms.map((term) => this.matchTerm(index, term));
    const pool = new Set(this.collectCandidateDocs(index, matches, limit, sort));
    if (this.shouldUseSubstringCandidateFallback(queryTerms, matches, phrase, pool.size)) {
      for (const docId of await this.collectSubstringCandidateDocs(terms, phrase, limit, sort, bodies)) {
        pool.add(docId);
      }
    }

    const docs = Array.from(pool);
    this.lastLexicalInspect = docs.length;

    // Body checks that tokens can't settle read each note once, up front.
    const bodyNeedles = [phrase, ...queryTerms.filter((term) => this.isUnmatchedTerm(term)).map((term) => term.value)];
    await bodies.load(docs.filter((docId) => bodyNeedles.some((needle) => bodies.needsText(docId, needle))), this.CONTENT_CONCURRENCY);

    const scored = docs
      .map((docId) => this.scoreDocument(docId, queryTerms, matches, phrase, bodies))
      .filter((r): r is SearchHit => r !== null)
      .sort((a, b) => this.compareHits(a, b, sort))
      .slice(0, limit * 2); // keep extra for merge step

    return scored;
  }

  private scoreDocument(
    docId: number,
    queryTerms: QueryTerm[],
    matches: TermMatches[],
    phrase: string,
    bodies: NoteBodyMatcher,
  ): SearchHit | null {
    const note = bodies.index.note(docId);
    if (!note || queryTerms.length === 0) return null;
    let total = 0;
    let matchedTerms = 0;
    let phraseMatched = false;

    for (let index = 0; index < queryTerms.length; index += 1) {
      const fieldScore = this.scoreTermInDocument(docId, note, queryTerms[index], matches[index], bodies);
      if (fieldScore > 0) {
        total += fieldScore;
        matchedTerms += 1;
      }
    }

    if (phrase) {
      if (note.lowerTitle.includes(phrase)) {
        total += 20;
        phraseMatched = true;
      }
      if (note.lowerPath.includes(phrase)) {
        total += 10;
        phraseMatched = true;
      }
      if (bodies.contains(docId, phrase)) {
        total += 14;
        phraseMatched = true;
      }
    }

    if (matchedTerms === 0 && !phraseMatched) return null;

    const coverageRatio = matchedTerms / queryTerms.length;
    const coverageBonus = matchedTerms > 0 ? coverageRatio * 16 : 0;
    total += coverageBonus;

    total += this.computeRecencyBoost(note.mtime) * Math.max(0.15, coverageRatio);

    const maxPossible = queryTerms.length * 24 + 60;
    const score = Math.min(1, total / maxPossible);

    if (score <= 0) return null;

    return {
      path: note.path,
      title: note.title,
      score,
      lexScore: score,
      origin: "lexical",
      updatedAt: note.mtime,
      size: note.size,
    };
  }

  private scoreTermInDocument(
    docId: number,
    note: IndexedNote,
    term: QueryTerm,
    match: TermMatches,
    bodies: NoteBodyMatcher,
  ): number {
    const exact = match.exact[docId];
    let total = 0;
    if (exact & TITLE_FIELD) total += 14;
    if (exact & PATH_FIELD) total += 7;
    if (exact & BODY_FIELD) total += 5;

    if (total > 0) return total;

    const prefix = match.prefix[docId];
    if (prefix & TITLE_FIELD) total += 11;
    if (prefix & PATH_FIELD) total += 5;
    if (prefix & BODY_FIELD) total += 3.5;

    if (total > 0) return total;

    const fuzzy = match.fuzzy[docId];
    if (fuzzy & TITLE_FIELD) total += 9;
    if (fuzzy & PATH_FIELD) total += 4;
    if (fuzzy & BODY_FIELD) total += 2.5;

    if (total > 0) return total;

    // Non-tokenizable terms (e.g. emoji, single characters, symbol-only) have
    // empty exact/prefix/fuzzy sets, so token-based scoring always returns 0
    // even when the candidate pool added the doc via substring fallback. Score
    // these by substring so mixed queries like "launch 🚀" still credit docs
    // that only contain the non-tokenizable portion.
    if (this.isUnmatchedTerm(term)) {
      if (note.lowerTitle.includes(term.value)) total += 9;
      if (note.lowerPath.includes(term.value)) total += 4;
      if (bodies.contains(docId, term.value)) total += 3;
    }

    return total;
  }

  /** A term no indexed token matches, scored by substring instead. */
  private isUnmatchedTerm(term: QueryTerm): boolean {
    return term.exact.size === 0 && term.prefix.size === 0 && term.fuzzy.size === 0 && term.value.length > 0;
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

  private buildQueryTerms(index: SearchTextIndex, terms: string[]): QueryTerm[] {
    return terms.map((value) => {
      const exact = new Set<string>();
      const prefix = new Set<string>();
      const fuzzy = new Set<string>();

      // Single-character body runs are indexed for substring checks only.
      if (value.length > 1 && index.hasToken(value)) {
        exact.add(value);
      }

      if (value.length >= 3) {
        for (const token of index.prefixTokens(value, this.PREFIX_TOKEN_LIMIT)) {
          if (token === value) continue;
          prefix.add(token);
        }
        for (const token of this.findIndexedQueryPrefixes(index, value, this.PREFIX_TOKEN_LIMIT - prefix.size)) {
          if (token === value) continue;
          prefix.add(token);
        }

        if (value.length >= 5 && prefix.size < 16) {
          const maxGap = Math.max(2, Math.floor(value.length * 0.45));
          let fuzzyCount = 0;
          for (const token of index.tokensByLength(Math.max(1, value.length - maxGap), value.length + maxGap)) {
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

  private findIndexedQueryPrefixes(index: SearchTextIndex, value: string, limit: number): string[] {
    if (limit <= 0) return [];
    const matches: string[] = [];
    for (let length = value.length - 1; length >= 3 && matches.length < limit; length -= 1) {
      const prefix = value.slice(0, length);
      if (index.hasToken(prefix)) {
        matches.push(prefix);
      }
    }
    return matches;
  }

  /** Every note the term's exact, prefix and fuzzy tokens reach, with their fields. */
  private matchTerm(index: SearchTextIndex, term: QueryTerm): TermMatches {
    const count = index.docCount;
    const seen = new Uint8Array(count);
    const matches: TermMatches = {
      docs: [],
      exact: new Uint8Array(count),
      prefix: new Uint8Array(count),
      fuzzy: new Uint8Array(count),
    };
    const collect = (tokens: Set<string>, fields: Uint8Array) => {
      for (const token of tokens) {
        index.forEachPosting(token, (docId, bits) => {
          fields[docId] |= bits;
          if (seen[docId] === 0) {
            seen[docId] = 1;
            matches.docs.push(docId);
          }
        });
      }
    };
    collect(term.exact, matches.exact);
    collect(term.prefix, matches.prefix);
    collect(term.fuzzy, matches.fuzzy);
    return matches;
  }

  private collectCandidateDocs(index: SearchTextIndex, matches: TermMatches[], limit: number, sort: SortMode): number[] {
    const counts = new Map<number, number>();
    for (const match of matches) {
      for (const docId of match.docs) {
        counts.set(docId, (counts.get(docId) ?? 0) + 1);
      }
    }

    if (counts.size === 0) {
      return [];
    }

    const targetMatches = matches.length >= 3
      ? Math.max(2, matches.length - 1)
      : 1;

    let candidates = this.docsForCounts(index, counts, targetMatches, limit, sort);
    if (candidates.length < limit) {
      candidates = this.docsForCounts(index, counts, Math.max(1, targetMatches - 1), limit, sort);
    }

    return candidates.slice(0, Math.max(limit * 8, this.CANDIDATE_LIMIT));
  }

  private shouldUseSubstringCandidateFallback(
    queryTerms: QueryTerm[],
    matches: TermMatches[],
    phrase: string,
    candidateCount: number,
  ): boolean {
    if (!phrase) return false;
    if (candidateCount === 0 && (containsNonAscii(phrase) || this.tokenizeSearchText(phrase).size === 0)) {
      return true;
    }
    return queryTerms.some((term, index) => this.needsSubstringFallback(term.value) && matches[index].docs.length === 0);
  }

  private needsSubstringFallback(value: string): boolean {
    if (!value) return false;
    // Prefix expansion in buildQueryTerms requires length >= 3, so 1- and
    // 2-char tokenizable terms (e.g. "fr" while typing "fresh") would
    // otherwise have no candidates once the content index is ready. The
    // `matches[index].docs.length === 0` gate in the caller still avoids
    // running a substring scan when the term has exact token coverage.
    if (value.length < 3) return true;
    // Token index stores punctuation-stripped tokens, so a query term
    // containing separators (e.g. "orange-juice", "don't") can never hit the
    // token index directly — the body still contains the substring, so fall
    // back to the substring scan to recover the match.
    if (/[^\p{L}\p{N}\p{M}]/u.test(value)) return true;
    return containsNonAscii(value) || this.tokenizeSearchText(value).size === 0;
  }

  private async collectSubstringCandidateDocs(
    terms: string[],
    phrase: string,
    limit: number,
    sort: SortMode,
    bodies: NoteBodyMatcher,
  ): Promise<number[]> {
    const matches: number[] = [];
    const cap = Math.max(limit * 8, this.CANDIDATE_LIMIT);
    const needles = [phrase, ...terms].filter(Boolean);

    const index = bodies.index;
    for (const docId of index.docIds()) {
      if (await this.documentContainsAny(docId, needles, bodies)) {
        matches.push(docId);
        if (sort !== "recency" && matches.length >= cap) break;
      }
    }

    if (sort === "recency") matches.sort((a, b) => this.noteMtime(index, b) - this.noteMtime(index, a));
    return matches.slice(0, cap);
  }

  private async documentContainsAny(docId: number, needles: string[], bodies: NoteBodyMatcher): Promise<boolean> {
    const note = bodies.index.note(docId);
    if (!note) return false;
    if (needles.some((needle) => note.lowerTitle.includes(needle) || note.lowerPath.includes(needle))) return true;
    const unread = needles.filter((needle) => bodies.needsText(docId, needle));
    if (unread.length > 0) await bodies.load([docId], 1);
    return needles.some((needle) => bodies.contains(docId, needle));
  }

  private noteMtime(index: SearchTextIndex, docId: number): number {
    return index.note(docId)?.mtime ?? 0;
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
      .sort((a, b) => this.compareHits(a, b, sort))
      .slice(0, limit);

    return hits;
  }

  private scoreMetadataFile(file: TFile, queryTerms: QueryTerm[], phrase: string): SearchHit | null {
    const title = file.basename;
    const path = file.path;
    const metadata = this.getMetadataTokenSnapshot(file);
    const metadataScore = this.scoreMetadata(metadata, this.modifiedTime(file), queryTerms, phrase);
    if (metadataScore <= 0) return null;

    const maxPossible = Math.max(24, queryTerms.length * 20 + 24);
    const score = Math.min(1, metadataScore / maxPossible);
    return {
      path,
      title,
      score,
      lexScore: score,
      origin: "lexical",
      updatedAt: this.modifiedTime(file),
      size: this.fileSize(file),
    };
  }

  private scoreMetadata(doc: MetadataTokenSnapshot, mtime: number, queryTerms: QueryTerm[], phrase: string): number {
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
    score += this.computeRecencyBoost(mtime) * 0.15;
    return score;
  }

  private docsForCounts(
    index: SearchTextIndex,
    counts: Map<number, number>,
    minCount: number,
    limit: number,
    sort: SortMode,
  ): number[] {
    return Array.from(counts.entries())
      .filter(([, count]) => count >= minCount)
      .sort((a, b) => sort === "recency"
        ? (this.noteMtime(index, b[0]) || 0) - (this.noteMtime(index, a[0]) || 0) || b[1] - a[1]
        : b[1] - a[1])
      .slice(0, Math.max(limit * 8, this.CANDIDATE_LIMIT))
      .map(([docId]) => docId);
  }

  /** Excerpts for the word results shown, from each note's text read again. */
  private async attachExcerpts(
    results: SearchHit[],
    terms: string[],
    phrase: string,
    bodies: NoteBodyMatcher,
  ): Promise<void> {
    const shown: Array<{ hit: SearchHit; docId: number }> = [];
    for (const hit of results) {
      if (hit.origin !== "lexical" && hit.origin !== "blend") continue;
      const docId = bodies.index.idOf(hit.path);
      if (docId !== undefined) shown.push({ hit, docId });
    }
    await bodies.load(shown.map(({ docId }) => docId), this.CONTENT_CONCURRENCY);
    for (const { hit, docId } of shown) {
      const note = bodies.index.note(docId);
      if (!note) continue;
      hit.excerpt = copyFlat(this.extractExcerpt(bodies.text(docId)?.raw ?? "", note.preview, terms, phrase));
    }
  }

  private extractExcerpt(raw: string, preview: string, terms: string[], phrase: string): string {
    const source = raw || preview;
    if (!source) return preview;

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
      return preview;
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
    const manager = this.getExistingEmbeddingsManager();
    if (!manager || signal?.aborted) return [];
    // One controller for the whole semantic leg: the caller's cancellation
    // aborts the managed query and the vector scan behind it, instead of
    // leaving them running after the results were dropped.
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const semantic = (async (): Promise<SearchHit[]> => {
        if (typeof manager.awaitReady === "function") {
          await manager.awaitReady();
        }
        if (controller.signal.aborted) return [];
        const rawResults = await manager.searchSimilar(query, limit, controller.signal);
        if (controller.signal.aborted) return [];
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
            } satisfies SearchHit;
          })
          .filter((hit): hit is NonNullable<typeof hit> => hit !== null);
      })();
      const aborted = new Promise<SearchHit[]>((resolve) => {
        if (controller.signal.aborted) resolve([]);
        controller.signal.addEventListener("abort", () => resolve([]), { once: true });
      });
      return await Promise.race([semantic, aborted]);
    } catch {
      return [];
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private shouldUseEmbeddings(
    mode: SearchMode,
    indicator: EmbeddingsIndicator,
    terms: string[],
    query: string,
  ): boolean {
    if (mode === "lexical") return false;
    if (!indicator.enabled || !indicator.ready || !indicator.available) return false;
    if (mode === "semantic") return true;
    if (terms.length === 0 || query.length < this.MIN_SEMANTIC_QUERY_CHARS) return false;

    const total = indicator.total ?? 0;
    const processed = indicator.processed ?? 0;
    if (total <= 0) return indicator.available;

    return processed / total >= 0.75;
  }

  private compareHits(a: SearchHit, b: SearchHit, sort: SortMode): number {
    const recency = (b.updatedAt || 0) - (a.updatedAt || 0);
    const relevance = b.score - a.score;
    return sort === "recency" ? recency || relevance : relevance || recency;
  }

  /**
   * Word and meaning scores are separate evidence that a note is the one being
   * looked for, so they combine as a probabilistic OR: a note found both ways
   * ranks above a note found either way alone with the same score, and a note
   * found one way keeps that score. A weighted average would let a weak word
   * match pull a good meaning match below notes found by meaning alone.
   */
  private mergeResults(lexical: SearchHit[], semantic: SearchHit[], limit: number, sort: SortMode): SearchHit[] {
    const entries = new Map<string, { lex?: SearchHit; sem?: SearchHit }>();
    for (const hit of lexical) entries.set(hit.path, { lex: hit });
    for (const hit of semantic) {
      const entry = entries.get(hit.path);
      if (entry) entry.sem = hit;
      else entries.set(hit.path, { sem: hit });
    }

    const merged: SearchHit[] = [];
    for (const { lex, sem } of entries.values()) {
      const lexScore = lex?.lexScore ?? 0;
      const semScore = sem?.semScore ?? 0;
      merged.push({
        ...(lex ?? sem!),
        origin: lex && sem ? "blend" : lex ? "lexical" : "semantic",
        score: 1 - (1 - lexScore) * (1 - semScore),
        lexScore: lex?.lexScore,
        semScore: sem?.semScore,
      });
    }

    return merged.sort((a, b) => this.compareHits(a, b, sort)).slice(0, limit);
  }

  /**
   * Readiness summary shown with results. Counting indexed notes walks every
   * eligible file, so the answer is cached until the index revision or the
   * lifecycle snapshot changes.
   */
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
      const key = typeof manager.getIndexRevision === "function" && typeof manager.getLifecycleSnapshot === "function"
        ? `${ready}:${manager.getIndexRevision()}:${manager.getLifecycleSnapshot().updatedAt}`
        : null;
      if (key !== null && this.embeddingsIndicatorCache?.key === key) {
        return { ...this.embeddingsIndicatorCache.indicator };
      }
      const stats = typeof manager.getStats === "function" ? manager.getStats() : { total: 0, processed: 0, present: 0, needsProcessing: 0 };
      const available = typeof manager.hasAnyEmbeddings === "function" ? manager.hasAnyEmbeddings() : (stats.present ?? 0) > 0;

      const indicator: EmbeddingsIndicator = {
        enabled,
        ready,
        available,
        processed: stats.processed ?? stats.present ?? 0,
        total: stats.total,
      };
      this.embeddingsIndicatorCache = key === null ? null : { key, indicator: { ...indicator } };
      return indicator;
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
   * lexical-only results. Errors (missing license or managed-service failure) are
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

const WORD_PATTERN = /^[\p{L}\p{N}\p{M}]+$/u;
const WORD_RUNS_PATTERN = /[\p{L}\p{N}\p{M}]{2,}/gu;

/**
 * Answers "does this note's indexed body contain this text" for one search,
 * as `body.includes` did when the index kept bodies. A word (letters, digits
 * and marks only) is answered from the index. Other text is narrowed to the
 * notes holding each of its words, then checked against the note's text, read
 * at most once per search and dropped with the matcher.
 */
class NoteBodyMatcher {
  private wordMasks = new Map<string, Uint8Array>();
  private candidateMasks = new Map<string, Uint8Array | null>();
  private texts = new Map<number, NoteText>();

  constructor(
    readonly index: SearchTextIndex,
    private readonly read: (note: IndexedNote) => Promise<NoteText>,
  ) {}

  /** True when only the note's text can settle `contains(docId, needle)`. */
  needsText(docId: number, needle: string): boolean {
    if (!needle || WORD_PATTERN.test(needle) || this.texts.has(docId)) return false;
    const candidates = this.candidates(needle);
    return candidates === null || candidates[docId] === 1;
  }

  /** Reads the notes' text; `contains` and `text` answer from it afterwards. */
  async load(docIds: number[], concurrency: number): Promise<void> {
    const pending = Array.from(new Set(docIds)).filter((docId) => !this.texts.has(docId));
    let next = 0;
    const worker = async () => {
      while (next < pending.length) {
        const docId = pending[next++];
        const note = this.index.note(docId);
        if (note) this.texts.set(docId, await this.read(note));
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  }

  contains(docId: number, needle: string): boolean {
    if (!needle) return false;
    if (WORD_PATTERN.test(needle)) return this.wordMask(needle)[docId] === 1;
    const candidates = this.candidates(needle);
    if (candidates !== null && candidates[docId] !== 1) return false;
    return this.texts.get(docId)?.body.includes(needle) ?? false;
  }

  text(docId: number): NoteText | undefined {
    return this.texts.get(docId);
  }

  private wordMask(word: string): Uint8Array {
    let mask = this.wordMasks.get(word);
    if (!mask) {
      mask = this.index.bodyContainsWord(word);
      this.wordMasks.set(word, mask);
    }
    return mask;
  }

  /** Notes holding every word of `needle` that is two or more characters long; null when it has none. */
  private candidates(needle: string): Uint8Array | null {
    if (this.candidateMasks.has(needle)) return this.candidateMasks.get(needle)!;
    let candidates: Uint8Array | null = null;
    for (const word of needle.match(WORD_RUNS_PATTERN) ?? []) {
      const mask = this.wordMask(word);
      if (candidates === null) {
        candidates = mask.slice();
      } else {
        for (let docId = 0; docId < candidates.length; docId += 1) candidates[docId] &= mask[docId];
      }
    }
    this.candidateMasks.set(needle, candidates);
    return candidates;
  }
}
