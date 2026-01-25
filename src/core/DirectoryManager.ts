import { App, TFolder, EventRef } from "obsidian";
import SystemSculptPlugin from "../main";
import { SystemSculptSettings } from "../types";

/**
 * DirectoryManager
 *
 * Centralizes all directory operations for the plugin.
 * Responsible for ensuring the proper directory structure exists
 * and providing access to directories for components.
 */
export class DirectoryManager {
  private app: App;
  private plugin: SystemSculptPlugin;
  private directories: Map<string, boolean> = new Map();
  private initialized: boolean = false;
  private initializationPromise: Promise<void> | null = null;
  private verifiedDirectories: Set<string>;
  private verifiedPersistTimer: number | null = null;
  private verificationPromises: Map<string, Promise<void>> = new Map();
  private directoriesReadyNotified = false;

  constructor(app: App, plugin: SystemSculptPlugin) {
    this.app = app;
    this.plugin = plugin;
    const stored = plugin.settings?.verifiedDirectories ?? [];
    this.verifiedDirectories = new Set(
      Array.isArray(stored) ? stored.map((dir) => this.normalizePath(dir)) : []
    );
  }

  /**
   * Check if the directory manager has been initialized
   */
  public isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Initialize all required directories for the plugin
   * This should be called early in the plugin startup process
   * @param timeoutMs Timeout in milliseconds for the entire initialization (defaults to 12000ms)
   */
  public async initialize(timeoutMs: number = 12000): Promise<void> {
    // If initialization is in progress, return the existing promise
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    // If already initialized, just return
    if (this.initialized) {
      return;
    }

    // Start initialization with timeout
    const initPromise = this._initialize();

    // Create a timeout promise
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Directory initialization timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    // Race the initialization against the timeout
    this.initializationPromise = Promise.race([initPromise, timeoutPromise]);

    try {
      await this.initializationPromise;
      this.initialized = true;
      this.initializationPromise = null;
    } catch (error) {
      this.initializationPromise = null;
      if (error instanceof Error && error.message.includes('timed out')) {
        // Mark as initialized anyway to prevent blocking the rest of the plugin
        this.initialized = true;
      } else {
        throw error;
      }
    }
  }

  /**
   * Internal initialization method - optimized for parallel execution
   */
  private async _initialize(): Promise<void> {
    try {
      const initStart = performance.now();
      
      // Get all directory paths from settings
      const settings = this.plugin.settings;
      const directories = [
        settings.chatsDirectory,
        settings.savedChatsDirectory,
        settings.benchmarksDirectory,
        settings.recordingsDirectory,
        settings.systemPromptsDirectory,
        settings.attachmentsDirectory,
        settings.extractionsDirectory
      ].filter(dir => dir && dir.trim() !== "");


      // Check if any directory starts with "SystemSculpt/"
      const needsSystemSculptDir = directories.some(dir => dir.startsWith("SystemSculpt/"));

      // Create SystemSculpt directory first if needed (other dirs might depend on it)
      if (needsSystemSculptDir) {
        await this.createDirectoryOptimized("SystemSculpt", true);
      }

      // Create all directories in parallel with optimized operations
      const directoryPromises = directories.map(async (dir) => {
        try {
          await this.createDirectoryOptimized(dir);
          return { dir, success: true, error: null };
        } catch (error) {
          return { dir, success: false, error };
        }
      });

      const results = await Promise.allSettled(directoryPromises);
      
      // Log results
      const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
      const failed = results.length - successful;
      

      // Notify that the directory structure is now ready
      this.notifyDirectoriesReady();

    } catch (error) {
      // Don't throw - allow plugin to continue with degraded directory support
      this.notifyDirectoriesReady();
    }
  }

  /**
   * Notify that directories are ready
   * Components can listen for this event
   */
  private notifyDirectoriesReady(): void {
    if (this.directoriesReadyNotified) {
      return;
    }
    this.directoriesReadyNotified = true;
    if (typeof window !== "undefined") {
      (window as any).__systemsculptDirectoriesReady = true;
    }
    // If plugin has emitter, use it
    if (this.plugin.emitter && typeof this.plugin.emitter.emit === 'function') {
      this.plugin.emitter.emit("directory-structure-ready");
    } else {
      // Otherwise, dispatch a custom event on the app
      const event = new CustomEvent("systemsculpt:directory-structure-ready", {
        detail: { plugin: this.plugin }
      });
      window.dispatchEvent(event);

      // Log that we're using window events as fallback
    }
  }

  /**
   * Get a directory path, ensuring it exists
   * Components should use this instead of accessing settings directly
   */
  public getDirectory(key: keyof SystemSculptSettings): string {
    if (!this.initialized) {
      throw new Error("Directory manager not initialized. Wait for initialization to complete.");
    }

    const path = this.plugin.settings[key] as string;
    if (!path || !this.directories.get(path)) {
      throw new Error(`Directory not available: ${key}`);
    }
    return path;
  }

  /**
   * Create a specific directory by key if not in the original initialization
   * Used when a new directory is needed after initialization
   */
  public async ensureDirectoryByKey(key: keyof SystemSculptSettings): Promise<string> {
    if (!this.initialized) {
      await this.initialize();
    }

    const path = this.plugin.settings[key] as string;
    if (!path || path.trim() === "") {
      throw new Error(`No path configured for: ${key}`);
    }

    await this.createDirectory(path);
    return path;
  }

  /**
   * Create a specific directory by path
   * Used for direct path creation
   */
  public async ensureDirectoryByPath(dirPath: string): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (!dirPath || dirPath.trim() === "") {
      throw new Error("Cannot create directory: empty path provided");
    }

    await this.createDirectory(dirPath);
  }

  /**
   * Called when directory settings change
   * Ensures the new directories exist
   */
  public async handleDirectorySettingChange(key: keyof SystemSculptSettings, newPath: string): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    if (newPath && newPath.trim() !== "") {
      await this.createDirectory(newPath);
    }
  }

  /**
   * Optimized directory creation method with reduced file system operations
   * @param dirPath Directory path to create
   * @param createMarker Whether to create a marker file
   */
  private async createDirectoryOptimized(dirPath: string, createMarker: boolean = false): Promise<void> {
    // Validate the directory path
    if (!dirPath || dirPath.trim() === "") {
      throw new Error("Cannot create directory: empty or invalid path");
    }

    // Normalize the path
    const normalizedPath = this.normalizePath(dirPath);
    
    // Check if we already know this directory exists
    if (this.directories.get(normalizedPath)) {
      return;
    }

    if (this.verifiedDirectories.has(normalizedPath)) {
      this.directories.set(normalizedPath, true);
      this.enqueueDirectoryHealthCheck(normalizedPath, createMarker);
      return;
    }

    const queueKey = `${normalizedPath}::${createMarker ? "marker" : "plain"}`;
    let verification = this.verificationPromises.get(queueKey);
    if (!verification) {
      verification = this.runDirectoryWork(() =>
        this.verifyAndCreateDirectory(normalizedPath, createMarker)
      );
      this.verificationPromises.set(queueKey, verification);
    }

    try {
      await verification;
    } catch (error) {
      // Handle "folder exists" errors gracefully
      if (error instanceof Error && error.message.includes("already exists")) {
        this.directories.set(normalizedPath, true);
        this.markDirectoryVerified(normalizedPath);
        return;
      }
      
      throw error;
    } finally {
      if (this.verificationPromises.get(queueKey) === verification) {
        this.verificationPromises.delete(queueKey);
      }
    }
  }

  /**
   * Legacy method for backward compatibility - now uses optimized version
   * @param dirPath Directory path to create
   * @param createMarker Whether to create a marker file
   * @param timeoutMs Timeout in milliseconds (ignored, kept for compatibility)
   * @param retryCount Number of retries attempted (ignored, kept for compatibility)
   */
  private async createDirectory(dirPath: string, createMarker: boolean = false, timeoutMs: number = 3000, retryCount: number = 0): Promise<void> {
    return this.createDirectoryOptimized(dirPath, createMarker);
  }

  /**
   * Original method with timeout and retry logic (kept for fallback)
   * @param dirPath Directory path to create
   * @param createMarker Whether to create a marker file
   * @param timeoutMs Timeout in milliseconds (defaults to 3000ms)
   * @param retryCount Number of retries attempted (for internal use)
   */
  private async createDirectoryWithRetry(dirPath: string, createMarker: boolean = false, timeoutMs: number = 3000, retryCount: number = 0): Promise<void> {
    // Validate the directory path
    if (!dirPath || dirPath.trim() === "") {
      throw new Error("Cannot create directory: empty or invalid path");
    }

    // Normalize the path to handle any potential issues
    const normalizedPath = this.normalizePath(dirPath);

    // Create a promise that will resolve with the directory creation result
    const directoryPromise = (async () => {
      try {
        // Handle nested paths
        const pathParts = normalizedPath.split('/');
        if (pathParts.length > 1) {
          // For any nested path, make sure the parent exists
          const parentPath = pathParts.slice(0, -1).join('/');
          await this.createDirectory(parentPath);
        }

        // Check if directory exists
        const exists = await this.app.vault.adapter.exists(normalizedPath);
        const folderExists = this.app.vault.getAbstractFileByPath(normalizedPath) instanceof TFolder;

        if (!exists || !folderExists) {
          await this.app.vault.createFolder(normalizedPath);
        } else {
          // Directory already exists - this is fine
        }

        // Create marker file if requested
        if (createMarker) {
          const markerPath = `${normalizedPath}/.folder`;
          const markerExists = await this.app.vault.adapter.exists(markerPath);
          if (!markerExists) {
            await this.app.vault.adapter.write(
              markerPath,
              "This file helps Obsidian recognize the directory."
            );
          }
        }

        // Mark directory as available
        this.directories.set(normalizedPath, true);
      } catch (error) {
        // Only throw if it's not a "folder exists" error
        if (!(error instanceof Error) || !error.message.includes("already exists")) {
          throw error;
        } else {
          // For "folder exists" errors, just mark the directory as available
          this.directories.set(normalizedPath, true);

        }
      }
    })();

    // Create a timeout promise
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Directory operation timed out after ${timeoutMs}ms: ${normalizedPath}`));
      }, timeoutMs);
    });

    // Race the directory creation against the timeout
    try {
      await Promise.race([directoryPromise, timeoutPromise]);
    } catch (error) {
      const isTimeout = error instanceof Error && error.message.includes('timed out');
      
      if (isTimeout && retryCount < 2) {
        // Retry with exponential backoff
        const backoffMs = 1000 * Math.pow(2, retryCount);
        
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        
        // Retry with a longer timeout
        return this.createDirectory(dirPath, createMarker, timeoutMs * 1.5, retryCount + 1);
      }
      
      // If it's a final failure or non-timeout error

      // For timeout errors after retries, check if directory was actually created
      if (isTimeout) {
        try {
          const exists = await this.app.vault.adapter.exists(normalizedPath);
          if (exists) {
            this.directories.set(normalizedPath, true);
            return; // Success!
          }
        } catch (checkError) {
        }
      }

      // Mark as failed in our directory cache  
      this.directories.set(normalizedPath, false);

      // Don't throw for non-critical directories, just log
      if (!dirPath.includes('System Prompts')) {
        throw error;
      } else {
      }
    }
  }

  /**
   * Normalize a directory path to handle edge cases
   * @param dirPath The directory path to normalize
   * @returns Normalized path
   */
  private normalizePath(dirPath: string): string {
    // Remove leading and trailing whitespace
    let path = dirPath.trim();

    // Remove leading and trailing slashes
    path = path.replace(/^\/+|\/+$/g, '');

    // Replace multiple consecutive slashes with a single slash
    path = path.replace(/\/+/g, '/');

    // Handle special case for root path
    if (path === '') {
      return '/';
    }

    return path;
  }

  private enqueueDirectoryHealthCheck(path: string, createMarker: boolean): void {
    void this.runDirectoryWork(() => this.verifyAndCreateDirectory(path, createMarker)).catch(
      () => {
        this.directories.set(path, false);
        this.verifiedDirectories.delete(path);
      }
    );
  }

  private async verifyAndCreateDirectory(path: string, createMarker: boolean): Promise<void> {
    // Single existence check
    const exists = await this.app.vault.adapter.exists(path);

    if (!exists) {
      await this.app.vault.createFolder(path);
    }

    if (createMarker) {
      const markerPath = `${path}/.folder`;
      const markerExists = await this.app.vault.adapter.exists(markerPath);
      if (!markerExists) {
        await this.app.vault.adapter.write(
          markerPath,
          "This file helps Obsidian recognize the directory."
        );
      }
    }

    this.directories.set(path, true);
    this.markDirectoryVerified(path);
  }

  private markDirectoryVerified(path: string): void {
    if (this.verifiedDirectories.has(path)) {
      return;
    }
    this.verifiedDirectories.add(path);
    this.scheduleVerifiedDirectoriesPersist();
  }

  private scheduleVerifiedDirectoriesPersist(): void {
    if (this.verifiedPersistTimer !== null) {
      return;
    }

    const schedule =
      typeof window !== "undefined" && typeof window.setTimeout === "function"
        ? window.setTimeout.bind(window)
        : setTimeout;

    this.verifiedPersistTimer = schedule(() => {
      this.verifiedPersistTimer = null;
      void this.plugin
        .getSettingsManager()
        .updateSettings({ verifiedDirectories: Array.from(this.verifiedDirectories) })
        .catch(() => {});
    }, 0);
  }

  private scheduleIdle(callback: () => void): void {
    const idle =
      typeof window !== "undefined" && typeof (window as any).requestIdleCallback === "function"
        ? (window as any).requestIdleCallback
        : null;

    if (idle) {
      idle(() => callback());
    } else {
      setTimeout(callback, 0);
    }
  }

  private runDirectoryWork<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.scheduleIdle(() => {
        work()
          .then(resolve)
          .catch(reject);
      });
    });
  }

  /**
   * Verify all directories are accessible
   * Used for diagnostics and repair
   */
  public async verifyDirectories(): Promise<{valid: boolean, issues: string[]}> {
    const issues: string[] = [];

    try {
      // Get all directory paths from settings
      const settings = this.plugin.settings;
      const directories = [
        settings.chatsDirectory,
        settings.savedChatsDirectory,
        settings.recordingsDirectory,
        settings.systemPromptsDirectory,
        settings.attachmentsDirectory,
        settings.extractionsDirectory
      ];

      // Check if any directory starts with "SystemSculpt/"
      const needsSystemSculptDir = directories.some(dir =>
        dir && dir.trim() !== "" && dir.startsWith("SystemSculpt/")
      );

      // Only check the SystemSculpt directory if needed
      if (needsSystemSculptDir) {
        const mainPath = "SystemSculpt";
        const mainExists = await this.app.vault.adapter.exists(mainPath);
        const mainFolder = this.app.vault.getAbstractFileByPath(mainPath) instanceof TFolder;

        if (!mainExists || !mainFolder) {
          issues.push(`Main directory "${mainPath}" does not exist`);
        }
      }

      // Check each directory
      for (const dir of directories) {
        if (!dir || dir.trim() === "") continue;

        const exists = await this.app.vault.adapter.exists(dir);
        const folder = this.app.vault.getAbstractFileByPath(dir) instanceof TFolder;

        if (!exists || !folder) {
          issues.push(`Directory "${dir}" does not exist or is not accessible`);
        }
      }
    } catch (error) {
      issues.push(`Error verifying directories: ${error.message}`);
    }

    return {
      valid: issues.length === 0,
      issues
    };
  }

  /**
   * Repair the directory structure
   * Used when issues are detected
   */
  public async repair(): Promise<boolean> {
    try {
      // Reset initialization state
      this.initialized = false;
      this.initializationPromise = null;

      // Clear directory cache
      this.directories.clear();

      // Get all directory paths from settings
      const settings = this.plugin.settings;
      const directories = [
        settings.chatsDirectory,
        settings.savedChatsDirectory,
        settings.recordingsDirectory,
        settings.systemPromptsDirectory,
        settings.attachmentsDirectory,
        settings.extractionsDirectory
      ];

      // Check if any directory starts with "SystemSculpt/"
      const needsSystemSculptDir = directories.some(dir =>
        dir && dir.trim() !== "" && dir.startsWith("SystemSculpt/")
      );

      // Only create the SystemSculpt directory if needed
      if (needsSystemSculptDir) {
        await this.createDirectory("SystemSculpt", true);
      }

      // Reinitialize all directories
      await this.initialize();
      return true;
    } catch (error) {
      return false;
    }
  }
}
