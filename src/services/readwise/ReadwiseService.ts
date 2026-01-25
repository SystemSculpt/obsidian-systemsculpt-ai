/**
 * Readwise Service
 * Handles syncing highlights and books from Readwise API
 */

import { normalizePath, Notice, TFile } from "obsidian";
import type SystemSculptPlugin from "../../main";
import { TypedEventEmitter } from "../../core/TypedEventEmitter";
import { httpRequest } from "../../utils/httpClient";
import { simpleHash } from "../../utils/cryptoUtils";
import { ReadwiseRateLimiter } from "./ReadwiseRateLimiter";
import { ReadwiseServiceError } from "./ReadwiseError";
import { ReadwiseSyncWidget } from "../../components/ReadwiseSyncWidget";
import type {
  ReadwiseBook,
  ReadwiseHighlight,
  ReadwiseExportResponse,
  ReadwiseSyncResult,
  ReadwiseSyncState,
  ReadwiseServiceEvents,
  SyncAction,
} from "../../types/readwise";
import {
  READWISE_AUTH_ENDPOINT,
  READWISE_EXPORT_ENDPOINT,
  CATEGORY_FOLDERS,
} from "../../types/readwise";

const SYNC_STATE_FILE = "sync-state.json";
const READWISE_STORAGE_DIR = ".systemsculpt/readwise";

export class ReadwiseService extends TypedEventEmitter<ReadwiseServiceEvents> {
  private plugin: SystemSculptPlugin;
  private rateLimiter: ReadwiseRateLimiter;
  private syncCancelled: boolean = false;
  private currentlySyncing: boolean = false;
  private scheduledSyncInterval: ReturnType<typeof setInterval> | null = null;
  private syncWidget: ReadwiseSyncWidget | null = null;
  private syncState: ReadwiseSyncState = {
    lastSyncTimestamp: 0,
    cursor: "",
    totalImported: 0,
    lastError: null,
    version: 2,
    sources: {},
    settingsHash: undefined,
  };

  constructor(plugin: SystemSculptPlugin) {
    super();
    this.plugin = plugin;
    this.rateLimiter = new ReadwiseRateLimiter();
  }

  /**
   * Initialize the service
   */
  async initialize(): Promise<void> {
    await this.loadSyncState();

    // Start scheduled sync if configured
    if (
      this.plugin.settings.readwiseEnabled &&
      this.plugin.settings.readwiseSyncMode === "interval"
    ) {
      this.startScheduledSync();
    }

    // Sync on load if configured
    if (
      this.plugin.settings.readwiseEnabled &&
      this.plugin.settings.readwiseSyncMode === "on-load" &&
      this.plugin.settings.readwiseApiToken
    ) {
      // Delay slightly to let the plugin fully load
      setTimeout(() => this.syncIncremental(), 5000);
    }
  }

  /**
   * Validate an API token
   */
  async validateApiToken(token: string): Promise<boolean> {
    if (!token || token.trim() === "") {
      return false;
    }

    try {
      await this.rateLimiter.waitForSlot();

      const response = await httpRequest({
        url: READWISE_AUTH_ENDPOINT,
        method: "GET",
        headers: {
          Authorization: `Token ${token}`,
        },
        timeoutMs: 10000,
      });

      const valid = response.status === 204;
      this.emit("auth:validated", { valid });
      return valid;
    } catch (error) {
      this.emit("auth:validated", { valid: false });
      return false;
    }
  }

  /**
   * Perform a full sync (ignores cursor, reimports everything)
   */
  async syncAll(): Promise<ReadwiseSyncResult> {
    return this.performSync(true);
  }

  /**
   * Perform an incremental sync (uses cursor from last sync)
   */
  async syncIncremental(): Promise<ReadwiseSyncResult> {
    return this.performSync(false);
  }

  /**
   * Cancel an ongoing sync
   */
  cancelSync(): void {
    this.syncCancelled = true;
  }

  /**
   * Check if a sync is currently in progress
   */
  isCurrentlySyncing(): boolean {
    return this.currentlySyncing;
  }

  /**
   * Get the current sync state
   */
  getSyncState(): ReadwiseSyncState {
    return { ...this.syncState };
  }

  /**
   * Start scheduled sync based on settings
   */
  startScheduledSync(): void {
    this.stopScheduledSync();

    if (!this.plugin.settings.readwiseEnabled) return;
    if (this.plugin.settings.readwiseSyncMode !== "interval") return;

    const intervalMinutes = this.plugin.settings.readwiseSyncIntervalMinutes || 1440;
    const intervalMs = intervalMinutes * 60 * 1000;

    this.scheduledSyncInterval = setInterval(() => {
      if (!this.currentlySyncing && this.plugin.settings.readwiseApiToken) {
        this.syncIncremental().catch((err) => {
          console.error("[Readwise] Scheduled sync failed:", err);
        });
      }
    }, intervalMs);

    // Check if we should sync immediately (last sync was longer ago than interval)
    const lastSync = this.plugin.settings.readwiseLastSyncTimestamp || 0;
    const timeSinceLastSync = Date.now() - lastSync;
    if (timeSinceLastSync >= intervalMs && this.plugin.settings.readwiseApiToken) {
      // Delay slightly to not block plugin load
      setTimeout(() => this.syncIncremental(), 3000);
    }
  }

  /**
   * Stop scheduled sync
   */
  stopScheduledSync(): void {
    if (this.scheduledSyncInterval) {
      clearInterval(this.scheduledSyncInterval);
      this.scheduledSyncInterval = null;
    }
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    this.stopScheduledSync();
    this.cancelSync();
    if (this.syncWidget) {
      this.syncWidget.destroy();
      this.syncWidget = null;
    }
    this.clear(); // Clear event listeners
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private showSyncWidget(): void {
    if (!this.syncWidget) {
      this.syncWidget = new ReadwiseSyncWidget(this.plugin);
    }
    this.syncWidget.show();
  }

  private async performSync(fullSync: boolean): Promise<ReadwiseSyncResult> {
    if (this.currentlySyncing) {
      return {
        success: false,
        imported: 0,
        updated: 0,
        skipped: 0,
        errors: 1,
        errorMessages: ["Sync already in progress"],
      };
    }

    const token = this.plugin.settings.readwiseApiToken;
    if (!token) {
      return {
        success: false,
        imported: 0,
        updated: 0,
        skipped: 0,
        errors: 1,
        errorMessages: ["No API token configured"],
      };
    }

    this.currentlySyncing = true;
    this.syncCancelled = false;

    const result: ReadwiseSyncResult = {
      success: true,
      imported: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      errorMessages: [],
    };

    try {
      this.emit("sync:started", { timestamp: Date.now() });

      // Check if settings changed and invalidate cache if needed
      if (fullSync) {
        // Full sync clears cached state
        this.syncState.sources = {};
      }
      this.invalidateCacheIfSettingsChanged();

      // Determine cursor for incremental sync
      const cursor = fullSync ? undefined : this.syncState.cursor || undefined;
      const updatedAfter = fullSync
        ? undefined
        : this.syncState.lastSyncTimestamp
          ? new Date(this.syncState.lastSyncTimestamp).toISOString()
          : undefined;

      let nextCursor: string | null = cursor || null;
      let totalProcessed = 0;
      let estimatedTotal = 0;

      do {
        if (this.syncCancelled) {
          throw ReadwiseServiceError.syncCancelled();
        }

        // Fetch a page of results
        const response = await this.fetchExport(nextCursor || undefined, updatedAfter);
        estimatedTotal = response.count;

        // Process each book/source
        for (const book of response.results) {
          if (this.syncCancelled) {
            throw ReadwiseServiceError.syncCancelled();
          }

          try {
            const syncAction = await this.createOrUpdateSourceFile(book);
            switch (syncAction.action) {
              case "created":
                result.imported++;
                break;
              case "updated":
                result.updated++;
                break;
              case "skipped":
                result.skipped++;
                break;
            }
          } catch (error) {
            result.errors++;
            result.errorMessages.push(
              `Failed to process "${book.title}": ${error instanceof Error ? error.message : String(error)}`
            );
          }

          totalProcessed++;
          this.emit("sync:progress", {
            current: totalProcessed,
            total: estimatedTotal,
            currentItem: book.title,
          });
        }

        nextCursor = response.nextPageCursor;
      } while (nextCursor);

      // Update sync state
      this.syncState.lastSyncTimestamp = Date.now();
      this.syncState.cursor = "";
      this.syncState.totalImported += result.imported + result.updated;
      this.syncState.lastError = null;
      await this.saveSyncState();

      // Update settings
      await this.plugin.getSettingsManager().updateSettings({
        readwiseLastSyncTimestamp: this.syncState.lastSyncTimestamp,
        readwiseLastSyncCursor: "",
      });

      result.success = result.errors === 0;

      // Only show widget and emit completion if there were actual changes
      if (result.imported > 0 || result.updated > 0) {
        this.showSyncWidget();
        this.emit("sync:completed", result);
      }

      return result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      result.success = false;
      result.errors++;
      result.errorMessages.push(errorMessage);

      this.syncState.lastError = errorMessage;
      await this.saveSyncState();

      this.emit("sync:error", {
        error: error instanceof Error ? error : new Error(errorMessage),
      });

      if (!(error instanceof ReadwiseServiceError && error.code === "SYNC_CANCELLED")) {
        new Notice(`Readwise sync failed: ${errorMessage}`);
      }

      return result;
    } finally {
      this.currentlySyncing = false;
    }
  }

  private async fetchExport(
    cursor?: string,
    updatedAfter?: string
  ): Promise<ReadwiseExportResponse> {
    await this.rateLimiter.waitForSlot();

    const params = new URLSearchParams();
    if (cursor) params.set("pageCursor", cursor);
    if (updatedAfter) params.set("updatedAfter", updatedAfter);

    const url = params.toString()
      ? `${READWISE_EXPORT_ENDPOINT}?${params.toString()}`
      : READWISE_EXPORT_ENDPOINT;

    const response = await httpRequest({
      url,
      method: "GET",
      headers: {
        Authorization: `Token ${this.plugin.settings.readwiseApiToken}`,
      },
      timeoutMs: 30000,
    });

    // Handle rate limiting
    if (response.status === 429) {
      const retryAfter = parseInt(response.headers?.["retry-after"] || "60", 10);
      this.rateLimiter.handleRetryAfter(retryAfter);
      throw ReadwiseServiceError.fromHttpStatus(429, `Rate limited. Retry after ${retryAfter}s`);
    }

    if (response.status !== 200) {
      throw ReadwiseServiceError.fromHttpStatus(response.status);
    }

    if (!response.json) {
      throw new ReadwiseServiceError("Invalid response from Readwise API", {
        code: "INVALID_RESPONSE",
        transient: false,
      });
    }

    return response.json as ReadwiseExportResponse;
  }

  private async createOrUpdateSourceFile(book: ReadwiseBook): Promise<SyncAction> {
    const settings = this.plugin.settings;

    // Handle standalone tweets
    if (book.category === "tweets" && settings.readwiseTweetOrganization === "standalone") {
      return this.createStandaloneTweetFiles(book);
    }

    const filePath = this.getFilePath(book);
    const newContent = this.generateFileContent(book);
    const newHash = simpleHash(newContent);
    const sourceKey = String(book.user_book_id);

    // Fast path: check cached hash first
    const cached = this.syncState.sources?.[sourceKey];
    if (cached?.contentHash === newHash) {
      return { action: "skipped", reason: "unchanged" };
    }

    // Ensure directory exists
    const dirPath = filePath.substring(0, filePath.lastIndexOf("/"));
    await this.ensureDirectoryExists(dirPath);

    // Check if file exists
    const existingFile = this.plugin.app.vault.getAbstractFileByPath(filePath);

    if (existingFile) {
      // Read actual file to handle cache misses or external changes
      const existingContent = await this.plugin.app.vault.read(existingFile as TFile);
      if (simpleHash(existingContent) === newHash) {
        // File already has the right content, just update cache
        this.updateSourceCache(sourceKey, newHash, book.highlights?.length || 0);
        return { action: "skipped", reason: "unchanged" };
      }
      // Content differs - update file
      await this.plugin.app.vault.modify(existingFile as TFile, newContent);
      this.updateSourceCache(sourceKey, newHash, book.highlights?.length || 0);
      return { action: "updated" };
    }

    // Create new file
    await this.plugin.app.vault.create(filePath, newContent);
    this.updateSourceCache(sourceKey, newHash, book.highlights?.length || 0);
    return { action: "created" };
  }

  private async createStandaloneTweetFiles(book: ReadwiseBook): Promise<SyncAction> {
    const settings = this.plugin.settings;
    const baseFolder = settings.readwiseDestinationFolder || "SystemSculpt/Readwise";
    const organization = settings.readwiseOrganization || "by-category";

    // Determine folder path
    let folderPath: string;
    switch (organization) {
      case "by-category":
        folderPath = `${baseFolder}/${CATEGORY_FOLDERS.tweets}`;
        break;
      case "by-source":
        folderPath = `${baseFolder}/Twitter`;
        break;
      case "flat":
      default:
        folderPath = baseFolder;
        break;
    }

    await this.ensureDirectoryExists(folderPath);

    // Track what happened across all tweets in this book
    let anyCreated = false;
    let anyUpdated = false;

    // Create a file for each tweet (highlight)
    for (const highlight of book.highlights || []) {
      const newContent = this.generateTweetFileContent(book, highlight);
      const newHash = simpleHash(newContent);
      const fileName = this.getTweetFileName(highlight);
      const filePath = normalizePath(`${folderPath}/${fileName}.md`);
      const sourceKey = `tweet-${highlight.id}`;

      // Fast path: check cached hash first
      const cached = this.syncState.sources?.[sourceKey];
      if (cached?.contentHash === newHash) {
        continue; // Skip this tweet, unchanged
      }

      const existingFile = this.plugin.app.vault.getAbstractFileByPath(filePath);
      if (existingFile) {
        const existingContent = await this.plugin.app.vault.read(existingFile as TFile);
        if (simpleHash(existingContent) === newHash) {
          this.updateSourceCache(sourceKey, newHash, 1);
          continue;
        }
        await this.plugin.app.vault.modify(existingFile as TFile, newContent);
        this.updateSourceCache(sourceKey, newHash, 1);
        anyUpdated = true;
      } else {
        await this.plugin.app.vault.create(filePath, newContent);
        this.updateSourceCache(sourceKey, newHash, 1);
        anyCreated = true;
      }
    }

    // Return the most significant action
    if (anyCreated) return { action: "created" };
    if (anyUpdated) return { action: "updated" };
    return { action: "skipped", reason: "unchanged" };
  }

  private getTweetFileName(highlight: ReadwiseHighlight): string {
    // Use highlight ID and first part of text for uniqueness
    const textPreview = highlight.text
      .replace(/\n/g, " ")
      .substring(0, 50)
      .trim();
    const sanitized = this.sanitizeFileName(textPreview || `tweet-${highlight.id}`);
    return `${sanitized}-${highlight.id}`;
  }

  private generateTweetFileContent(book: ReadwiseBook, highlight: ReadwiseHighlight): string {
    const settings = this.plugin.settings;
    const importOptions = settings.readwiseImportOptions;
    const lines: string[] = [];

    // Frontmatter
    lines.push("---");
    lines.push("type: readwise-tweet");
    lines.push(`readwise_id: ${highlight.id}`);
    lines.push(`author: "${this.escapeYaml(book.author || book.title)}"`);

    // Saved date (converted to user's local timezone)
    if (importOptions.includeSavedDate) {
      const savedDate = highlight.highlighted_at || highlight.created_at || highlight.updated;
      if (savedDate) {
        lines.push(`saved_at: ${this.utcToLocalDate(savedDate)}`);
      }
    }

    if (highlight.url) {
      lines.push(`tweet_url: "${highlight.url}"`);
    }

    lines.push(`synced_at: ${new Date().toLocaleDateString("en-CA")}`);

    // Tags
    if (importOptions.tags && highlight.tags && highlight.tags.length > 0) {
      lines.push("tags:");
      for (const tag of highlight.tags) {
        lines.push(`  - readwise/${this.sanitizeTag(tag.name)}`);
      }
    }

    lines.push("---");
    lines.push("");

    // Tweet content
    lines.push(highlight.text);
    lines.push("");

    // Author attribution
    lines.push(`— **${book.author || book.title}**`);
    lines.push("");

    // Source link
    if (importOptions.fullDocument && highlight.url) {
      lines.push(`[View on Twitter](${highlight.url})`);
      lines.push("");
    }

    // Note if present
    if (importOptions.includeHighlightNotes && highlight.note) {
      lines.push("## Notes");
      lines.push("");
      lines.push(highlight.note);
      lines.push("");
    }

    return lines.join("\n");
  }

  private getFilePath(book: ReadwiseBook): string {
    const settings = this.plugin.settings;
    const baseFolder = settings.readwiseDestinationFolder || "Readwise";
    const organization = settings.readwiseOrganization || "by-category";

    // Sanitize title for filename
    const sanitizedTitle = this.sanitizeFileName(book.title || "Untitled");

    let folderPath: string;

    switch (organization) {
      case "by-category":
        const categoryFolder = CATEGORY_FOLDERS[book.category] || "Other";
        folderPath = `${baseFolder}/${categoryFolder}`;
        break;
      case "by-source":
        const sourceFolder = this.sanitizeFileName(book.source || "Unknown");
        folderPath = `${baseFolder}/${sourceFolder}`;
        break;
      case "flat":
      default:
        folderPath = baseFolder;
        break;
    }

    return normalizePath(`${folderPath}/${sanitizedTitle}.md`);
  }

  private generateFileContent(book: ReadwiseBook): string {
    const settings = this.plugin.settings;
    const importOptions = settings.readwiseImportOptions;
    const lines: string[] = [];

    // Frontmatter
    lines.push("---");
    lines.push("type: readwise");
    lines.push(`readwise_id: ${book.user_book_id}`);
    lines.push(`title: "${this.escapeYaml(book.title)}"`);
    if (book.author) {
      lines.push(`author: "${this.escapeYaml(book.author)}"`);
    }
    lines.push(`category: ${book.category}`);
    lines.push(`source: ${book.source}`);
    if (book.source_url) {
      lines.push(`source_url: "${book.source_url}"`);
    }
    if (book.cover_image_url) {
      lines.push(`cover_image: "${book.cover_image_url}"`);
    }
    lines.push(`num_highlights: ${book.highlights?.length || 0}`);

    // Saved date (use earliest highlight date)
    if (importOptions.includeSavedDate && book.highlights && book.highlights.length > 0) {
      const savedDate = this.getEarliestHighlightDate(book.highlights);
      if (savedDate) {
        lines.push(`saved_at: ${savedDate}`);
      }
    }

    lines.push(`synced_at: ${new Date().toLocaleDateString("en-CA")}`);

    // Tags
    if (importOptions.tags && book.book_tags && book.book_tags.length > 0) {
      lines.push("tags:");
      for (const tag of book.book_tags) {
        lines.push(`  - readwise/${this.sanitizeTag(tag.name)}`);
      }
    }

    lines.push("---");
    lines.push("");

    // Title
    lines.push(`# ${book.title}`);
    lines.push("");

    // Author
    if (book.author) {
      lines.push(`**Author:** ${book.author}`);
      lines.push("");
    }

    // Full Document section (source link and summary)
    if (importOptions.fullDocument && book.source_url) {
      lines.push("## Source");
      lines.push("");
      lines.push(`[Read original](${book.source_url})`);
      lines.push("");
    }

    // Document notes
    if (importOptions.bookNotes && book.document_note) {
      lines.push("## Document Notes");
      lines.push("");
      lines.push(book.document_note);
      lines.push("");
    }

    // Highlights
    if (importOptions.highlights && book.highlights && book.highlights.length > 0) {
      lines.push("## Highlights");
      lines.push("");

      for (const highlight of book.highlights) {
        lines.push(this.formatHighlight(highlight, importOptions));
        lines.push("");
      }
    }

    return lines.join("\n");
  }

  private formatHighlight(
    highlight: ReadwiseHighlight,
    importOptions: { includeHighlightNotes: boolean; tags: boolean }
  ): string {
    const lines: string[] = [];

    // Quote the highlight text
    lines.push(`> ${highlight.text.replace(/\n/g, "\n> ")}`);

    // Add note if present
    if (importOptions.includeHighlightNotes && highlight.note) {
      lines.push("");
      lines.push(`**Note:** ${highlight.note}`);
    }

    // Add tags if present
    if (importOptions.tags && highlight.tags && highlight.tags.length > 0) {
      const tagList = highlight.tags
        .map((t) => `#${this.sanitizeTag(t.name)}`)
        .join(" ");
      lines.push("");
      lines.push(`Tags: ${tagList}`);
    }

    lines.push("");
    lines.push("---");

    return lines.join("\n");
  }

  private sanitizeFileName(name: string): string {
    // Remove or replace invalid filename characters
    return name
      .replace(/[\\/:*?"<>|]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 200); // Limit length
  }

  private sanitizeTag(tag: string): string {
    return tag
      .replace(/[#\s]/g, "-")
      .replace(/[^a-zA-Z0-9\-_]/g, "")
      .toLowerCase();
  }

  private getEarliestHighlightDate(highlights: ReadwiseHighlight[]): string | null {
    const dates = highlights
      .map((h) => h.highlighted_at || h.created_at || h.updated)
      .filter((d): d is string => !!d)
      .sort();

    if (dates.length === 0) return null;
    return this.utcToLocalDate(dates[0]);
  }

  /**
   * Convert a UTC ISO timestamp to local date string (YYYY-MM-DD)
   * This ensures dates match the user's local timezone
   */
  private utcToLocalDate(utcTimestamp: string): string {
    const date = new Date(utcTimestamp);
    // 'en-CA' locale gives YYYY-MM-DD format
    return date.toLocaleDateString("en-CA");
  }

  private escapeYaml(str: string): string {
    return str.replace(/"/g, '\\"').replace(/\n/g, " ");
  }

  private async ensureDirectoryExists(path: string): Promise<void> {
    const parts = path.split("/").filter(Boolean);
    let currentPath = "";

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const folder = this.plugin.app.vault.getAbstractFileByPath(currentPath);
      if (!folder) {
        try {
          await this.plugin.app.vault.createFolder(currentPath);
        } catch (error) {
          // Ignore "folder already exists" errors (race condition)
          if (!(error instanceof Error && error.message.includes("already exists"))) {
            throw error;
          }
        }
      }
    }
  }

  private async loadSyncState(): Promise<void> {
    try {
      const stateDir = normalizePath(READWISE_STORAGE_DIR);
      const statePath = normalizePath(`${stateDir}/${SYNC_STATE_FILE}`);

      const file = this.plugin.app.vault.getAbstractFileByPath(statePath);
      if (file) {
        const content = await this.plugin.app.vault.read(file as TFile);
        const parsed = JSON.parse(content);
        this.syncState = { ...this.syncState, ...parsed };

        // Migrate from version 1 to version 2 (add sources tracking)
        if (!this.syncState.version || this.syncState.version < 2) {
          this.syncState.version = 2;
          this.syncState.sources = {};
          this.syncState.settingsHash = undefined;
          await this.saveSyncState();
        }
      }
    } catch (error) {
      console.warn("[Readwise] Failed to load sync state:", error);
    }
  }

  private async saveSyncState(): Promise<void> {
    try {
      const stateDir = normalizePath(READWISE_STORAGE_DIR);
      const statePath = normalizePath(`${stateDir}/${SYNC_STATE_FILE}`);

      await this.ensureDirectoryExists(stateDir);

      const content = JSON.stringify(this.syncState, null, 2);
      const file = this.plugin.app.vault.getAbstractFileByPath(statePath);

      if (file) {
        await this.plugin.app.vault.modify(file as TFile, content);
      } else {
        await this.plugin.app.vault.create(statePath, content);
      }
    } catch (error) {
      console.error("[Readwise] Failed to save sync state:", error);
    }
  }

  /**
   * Update the cached state for a source
   */
  private updateSourceCache(sourceKey: string, contentHash: string, highlightCount: number): void {
    if (!this.syncState.sources) {
      this.syncState.sources = {};
    }
    this.syncState.sources[sourceKey] = {
      contentHash,
      highlightCount,
      lastSyncedAt: new Date().toISOString(),
    };
  }

  /**
   * Get a hash of the settings that affect file content generation
   */
  private getSettingsHash(): string {
    const { readwiseImportOptions, readwiseOrganization, readwiseTweetOrganization } =
      this.plugin.settings;
    return simpleHash(
      JSON.stringify({ readwiseImportOptions, readwiseOrganization, readwiseTweetOrganization })
    );
  }

  /**
   * Invalidate the source cache if import-affecting settings have changed
   * @returns true if cache was invalidated
   */
  private invalidateCacheIfSettingsChanged(): boolean {
    const currentHash = this.getSettingsHash();
    if (this.syncState.settingsHash && this.syncState.settingsHash !== currentHash) {
      // Settings changed, clear all cached hashes so files are re-evaluated
      this.syncState.sources = {};
      this.syncState.settingsHash = currentHash;
      return true;
    }
    this.syncState.settingsHash = currentHash;
    return false;
  }
}
