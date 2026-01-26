/**
 * VaultFileCache - Centralized file caching system
 * 
 * Eliminates repeated expensive getMarkdownFiles() calls throughout the codebase
 * by maintaining a smart cache that updates incrementally via vault events.
 */

import { App, TFile, TFolder, EventRef, Vault } from 'obsidian';

interface FileStats {
  count: number;
  totalSize: number;
  lastUpdate: number;
}

export class VaultFileCache {
  private app: App;
  private vault: Vault;
  private markdownFiles: TFile[] | null = null;
  private allFiles: TFile[] | null = null;
  private fileStats: FileStats | null = null;
  private eventRefs: EventRef[] = [];
  private lastCacheUpdate = 0;
  private isInitialized = false;
  
  // Cache invalidation settings
  private readonly MAX_CACHE_AGE = 300000; // 5 minutes max cache age
  private readonly STATS_CACHE_AGE = 60000; // 1 minute for stats
  
  // Performance tracking
  private cacheHits = 0;
  private cacheMisses = 0;
  
  // Cleanup tracking
  private warmCacheTimeout: number | null = null;
  
  // Startup grace period to ignore file events during initial vault scanning
  private startupTime = 0;
  private readonly STARTUP_GRACE_PERIOD = 5000; // 5 seconds after initialization
  
  constructor(app: App) {
    this.app = app;
    this.vault = app.vault;
  }
  
  /**
   * Initialize the cache system with event listeners
   * Optimized to defer expensive operations until first use
   */
  async initialize(): Promise<void> {
    const initStart = performance.now();
    
    if (this.isInitialized) {
      return;
    }
    
    // Record startup time for grace period
    this.startupTime = Date.now();
    
    this.setupEventListeners();
    
    // OPTIMIZATION: Don't warm cache during initialization - defer until first use
    // This dramatically reduces startup time on large vaults
    
    this.isInitialized = true;
    
    // Schedule cache warming for after initialization completes
    this.warmCacheTimeout = window.setTimeout(() => {
      this.warmCache().then(() => {
      }).catch(error => {
      });
    }, 2000); // Warm cache 2 seconds after initialization
  }
  
  /**
   * Get all markdown files (cached)
   */
  getMarkdownFiles(): TFile[] {
    // Check if cache is valid
    if (this.isCacheValid() && this.markdownFiles) {
      this.cacheHits++;
      return [...this.markdownFiles]; // Return copy to prevent mutation
    }
    
    // Cache miss - refresh
    this.cacheMisses++;
    this.refreshMarkdownCache();
    return [...(this.markdownFiles || [])];
  }

  /**
   * Get a read-only view of cached markdown files (no copy).
   *
   * This is intended for performance-sensitive callers that treat the returned
   * array as immutable.
   */
  getMarkdownFilesView(): ReadonlyArray<TFile> {
    if (this.isCacheValid() && this.markdownFiles) {
      this.cacheHits++;
      return this.markdownFiles;
    }

    this.cacheMisses++;
    this.refreshMarkdownCache();
    return this.markdownFiles || [];
  }

  /**
   * Get all files (cached)
   */
  getAllFiles(): TFile[] {
    if (this.isCacheValid() && this.allFiles) {
      this.cacheHits++;
      return [...this.allFiles];
    }
    
    this.cacheMisses++;
    this.refreshAllFilesCache();
    return [...(this.allFiles || [])];
  }

  /**
   * Get a read-only view of cached files (no copy).
   *
   * This is intended for performance-sensitive callers that treat the returned
   * array as immutable.
   */
  getAllFilesView(): ReadonlyArray<TFile> {
    if (this.isCacheValid() && this.allFiles) {
      this.cacheHits++;
      return this.allFiles;
    }

    this.cacheMisses++;
    this.refreshAllFilesCache();
    return this.allFiles || [];
  }
  
  /**
   * Get file count (lightweight, cached)
   */
  getMarkdownFileCount(): number {
    if (this.isStatsCacheValid() && this.fileStats) {
      this.cacheHits++;
      return this.fileStats.count;
    }
    
    this.cacheMisses++;
    this.refreshFileStats();
    return this.fileStats?.count || 0;
  }
  
  /**
   * Get total vault size (cached)
   */
  getTotalVaultSize(): number {
    if (this.isStatsCacheValid() && this.fileStats) {
      this.cacheHits++;
      return this.fileStats.totalSize;
    }
    
    this.cacheMisses++;
    this.refreshFileStats();
    return this.fileStats?.totalSize || 0;
  }
  
  /**
   * Force refresh of all caches
   */
  invalidateCache(): void {
    this.markdownFiles = null;
    this.allFiles = null;
    this.fileStats = null;
    this.lastCacheUpdate = 0;
    // VaultFileCache cache invalidated silently
  }
  
  /**
   * Get cache performance statistics
   */
  getCacheStats(): { hits: number; misses: number; hitRatio: string } {
    const total = this.cacheHits + this.cacheMisses;
    const hitRatio = total > 0 ? ((this.cacheHits / total) * 100).toFixed(1) : '0.0';
    
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      hitRatio: `${hitRatio}%`
    };
  }
  
  /**
   * Cleanup resources
   */
  destroy(): void {
    // Clear any pending timeout
    if (this.warmCacheTimeout) {
      window.clearTimeout(this.warmCacheTimeout);
      this.warmCacheTimeout = null;
    }
    
    // Unregister event listeners
    for (const ref of this.eventRefs) {
      this.vault.offref(ref);
    }
    this.eventRefs = [];
    
    // Clear caches
    this.invalidateCache();
    this.isInitialized = false;
    
    const stats = this.getCacheStats();
    // VaultFileCache destroyed silently
  }
  
  // Private methods
  
  private isCacheValid(): boolean {
    return this.lastCacheUpdate > 0 && 
           (Date.now() - this.lastCacheUpdate) < this.MAX_CACHE_AGE;
  }
  
  private isStatsCacheValid(): boolean {
    return this.fileStats !== null && 
           (Date.now() - this.fileStats.lastUpdate) < this.STATS_CACHE_AGE;
  }
  
  private refreshMarkdownCache(): void {
    const refreshStart = performance.now();
    try {
      this.markdownFiles = this.vault.getMarkdownFiles();
      this.lastCacheUpdate = Date.now();
    } catch (error) {
      this.markdownFiles = [];
    }
  }
  
  private refreshAllFilesCache(): void {
    try {
      this.allFiles = this.vault.getFiles();
      this.lastCacheUpdate = Date.now();
    } catch (error) {
      this.allFiles = [];
    }
  }
  
  private refreshFileStats(): void {
    try {
      if (!this.markdownFiles) {
        this.refreshMarkdownCache();
      }
      
      const files = this.markdownFiles || [];
      const totalSize = files.reduce((sum, file) => sum + (file.stat?.size || 0), 0);
      
      this.fileStats = {
        count: files.length,
        totalSize,
        lastUpdate: Date.now()
      };
    } catch (error) {
      this.fileStats = { count: 0, totalSize: 0, lastUpdate: Date.now() };
    }
  }
  
  private async warmCache(): Promise<void> {
    const warmStart = performance.now();
    try {
      // Pre-populate the most commonly used caches
      this.refreshMarkdownCache();
      
      this.refreshFileStats();
    } catch (error) {
    }
  }
  
  private setupEventListeners(): void {
    // File creation
    this.eventRefs.push(
      this.vault.on('create', (file) => {
        // Check if we're in startup grace period
        const timeSinceStartup = Date.now() - this.startupTime;
        const isInGracePeriod = timeSinceStartup < this.STARTUP_GRACE_PERIOD;
        
        // Ignore events during startup grace period (likely existing files being scanned)
        if (isInGracePeriod) {
          return;
        }
        
        if (file instanceof TFile && this.isUserContentFile(file)) {
          this.handleFileChange('create');
        }
      })
    );
    
    // File modification (usually doesn't affect our caches, but could affect stats)
    this.eventRefs.push(
      this.vault.on('modify', (file) => {
        if (file instanceof TFile && this.isUserContentFile(file)) {
          // Only invalidate stats, not the file list
          this.fileStats = null;
        }
      })
    );
    
    // File deletion
    this.eventRefs.push(
      this.vault.on('delete', (file) => {
        if (file instanceof TFile && this.isUserContentFile(file)) {
          this.handleFileChange('delete');
        }
      })
    );
    
    // File rename
    this.eventRefs.push(
      this.vault.on('rename', (file) => {
        if (file instanceof TFile && this.isUserContentFile(file)) {
          this.handleFileChange('rename');
        }
      })
    );
  }
  
  /**
   * Check if a file is user content (not system files)
   */
  private isUserContentFile(file: TFile): boolean {
    const path = file.path;
    
    // Exclude .obsidian directory and its subdirectories
    if (path.startsWith('.obsidian/')) {
      return false;
    }
    
    // Exclude other common system/temp directories
    if (path.startsWith('.trash/') || 
        path.startsWith('node_modules/') || 
        path.startsWith('.git/') ||
        path.startsWith('dist/') ||
        path.startsWith('build/')) {
      return false;
    }
    
    // Include everything else as user content
    return true;
  }
  
  private handleFileChange(type: 'create' | 'delete' | 'rename'): void {
    // Invalidate caches that are affected by file structure changes
    this.markdownFiles = null;
    this.allFiles = null;
    this.fileStats = null;
    this.lastCacheUpdate = 0;
    
    // VaultFileCache cache invalidated due to file change silently
  }
} 
