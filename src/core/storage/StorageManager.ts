import { App, TFolder } from "obsidian";
import SystemSculptPlugin from "../../main";

/**
 * Storage location types
 */
export type StorageLocationType = 
  | 'settings'    // Settings backups
  | 'cache'       // Various cache data
  | 'temp'        // Temporary processing files
  | 'diagnostics' // Logs, metrics, and other diagnostics artifacts
  | 'benchmarks'; // Benchmark fixtures, runs, and logs

/**
 * Storage operation result
 */
export interface StorageOperationResult {
  success: boolean;
  error?: string;
  path?: string;
}

/**
 * Storage manager for SystemSculpt
 * Centralizes all storage operations and path management for vault-based storage
 * Note: The main settings file (data.json) is still managed by Obsidian's native API
 */
export class StorageManager {
  private app: App;
  private plugin: SystemSculptPlugin;
  
  // Base path for hidden storage in the vault
  private hiddenBasePath: string = '.systemsculpt';
  
  // Track initialization state
  private initialized: boolean = false;
  private initializationPromise: Promise<void> | null = null;
  private initializedBasePath: string | null = null;
  
  // Track created directories to avoid redundant checks
  private createdDirectories: Set<string> = new Set<string>();
  
  /**
   * Create a new StorageManager
   */
  constructor(app: App, plugin: SystemSculptPlugin) {
    this.app = app;
    this.plugin = plugin;
  }
  
  /**
   * Initialize the storage system
   * Creates necessary directories and ensures everything is ready
   */
  async initialize(): Promise<void> {
    const currentBasePath = this.getAdapterBasePath();

    // If already initialized, return immediately
    if (this.initialized) {
      const shouldReinitialize = await this.shouldReinitialize(currentBasePath);
      if (!shouldReinitialize) {
        return;
      }
      this.resetInitializationState();
    }
    
    // If initialization is in progress, wait for it
    if (this.initializationPromise) {
      return this.initializationPromise;
    }
    
    // Start initialization
    this.initializationPromise = this._initialize();
    
    try {
      await this.initializationPromise;
      this.initialized = true;
      this.initializedBasePath = currentBasePath;
    } catch (error) {
      throw error;
    } finally {
      this.initializationPromise = null;
    }
  }
  
  /**
   * Internal initialization method
   */
  private async _initialize(): Promise<void> {
    try {
      // Ensure base hidden directory exists
      await this.ensureDirectory(this.hiddenBasePath);
      
      // Create core subdirectories
      await Promise.all([
        this.ensureDirectory(this.getPath('settings')),
        this.ensureDirectory(this.getPath('settings', 'backups')),
        this.ensureDirectory(this.getPath('settings', 'emergency')),
        this.ensureDirectory(this.getPath('cache')),
        this.ensureDirectory(this.getPath('temp')),
        this.ensureDirectory(this.getPath('diagnostics'), true),
        this.ensureDirectory(this.getPath('benchmarks'))
      ]);
      
      // Storage system initialized - silent success
    } catch (error) {
      throw error;
    }
  }

  private getAdapterBasePath(): string | null {
    const adapter: any = this.app.vault.adapter as any;
    if (!adapter || typeof adapter.getBasePath !== "function") {
      return null;
    }
    try {
      return adapter.getBasePath();
    } catch {
      return null;
    }
  }

  private async shouldReinitialize(currentBasePath: string | null): Promise<boolean> {
    if (this.initializedBasePath && currentBasePath && this.initializedBasePath !== currentBasePath) {
      return true;
    }
    const adapter: any = this.app.vault.adapter as any;
    if (adapter && typeof adapter.exists === "function") {
      try {
        const exists = await adapter.exists(this.hiddenBasePath);
        if (!exists) {
          return true;
        }
      } catch {
        return true;
      }
    }
    return false;
  }

  private resetInitializationState(): void {
    this.initialized = false;
    this.initializedBasePath = null;
    this.createdDirectories.clear();
  }
  
  /**
   * Check if the storage system is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }
  
  /**
   * Get the path to a storage location in the vault's .systemsculpt directory
   * @param type The type of storage location
   * @param subPath Optional sub-path components
   * @returns The full path to the storage location
   */
  getPath(type: StorageLocationType, ...subPath: string[]): string {
    const basePath = `${this.hiddenBasePath}/${type}`;
    return subPath.length > 0 ? `${basePath}/${subPath.join('/')}` : basePath;
  }
  
  /**
   * Ensure a directory exists
   * @param path The path to ensure exists
   * @param createMarker Whether to create a marker file
   * @returns Promise resolving when directory is created
   */
  async ensureDirectory(path: string, createMarker: boolean = false): Promise<void> {
    // Normalize path to use forward slashes
    const normalizedPath = path.replace(/\\/g, '/');
    
    // If we've already created this directory, skip
    if (this.createdDirectories.has(normalizedPath)) {
      return;
    }
    
    try {
      // Handle nested paths
      const pathParts = normalizedPath.split('/');
      if (pathParts.length > 1) {
        // For any nested path, make sure the parent exists
        const parentPath = pathParts.slice(0, -1).join('/');
        if (parentPath) {
          await this.ensureDirectory(parentPath);
        }
      }
      
      // Check if directory exists
      const exists = await this.app.vault.adapter.exists(normalizedPath);
      const folderExists = this.app.vault.getAbstractFileByPath(normalizedPath) instanceof TFolder;
      
      if (!exists || !folderExists) {
        await this.app.vault.createFolder(normalizedPath);
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
      
      // Mark directory as created
      this.createdDirectories.add(normalizedPath);
    } catch (error) {
      // Only throw if it's not a "folder exists" error
      if (!(error instanceof Error) || !error.message.includes("already exists")) {
        throw error;
      } else {
        // For "folder exists" errors, just mark the directory as created
        this.createdDirectories.add(normalizedPath);
      }
    }
  }
  
  /**
   * Write data to a file
   * @param type Storage location type
   * @param fileName File name within the location
   * @param data Data to write (string or object)
   * @returns Promise resolving to operation result
   */
  async writeFile(
    type: StorageLocationType, 
    fileName: string, 
    data: string | object
  ): Promise<StorageOperationResult> {
    try {
      // Ensure storage is initialized
      await this.initialize();
      
      // Get full path
      const path = this.getPath(type, fileName);
      
      // Convert object to JSON if needed
      const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      
      // Write the file
      await this.app.vault.adapter.write(path, content);
      
      return { success: true, path };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Append a line of data to a file, creating it when missing.
   * Writes are serialized through the adapter to avoid race issues.
   */
  async appendToFile(
    type: StorageLocationType,
    fileName: string,
    data: string
  ): Promise<StorageOperationResult> {
    try {
      await this.initialize();

      const path = this.getPath(type, fileName);
      const payload = data.endsWith('\n') ? data : `${data}\n`;
      const adapter: any = this.app.vault.adapter as any;

      const exists = await this.app.vault.adapter.exists(path);

      if (!exists) {
        await this.app.vault.adapter.write(path, payload);
      } else if (typeof adapter.append === 'function') {
        await adapter.append(path, payload);
      } else {
        const existing = await this.app.vault.adapter.read(path);
        await this.app.vault.adapter.write(path, `${existing}${payload}`);
      }

      return { success: true, path };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMessage };
    }
  }
  
  /**
   * Read data from a file
   * @param type Storage location type
   * @param fileName File name within the location
   * @param parseJson Whether to parse the file as JSON
   * @returns Promise resolving to file content or parsed object
   */
  async readFile<T = any>(
    type: StorageLocationType, 
    fileName: string, 
    parseJson: boolean = false
  ): Promise<T | string | null> {
    try {
      // Get full path
      const path = this.getPath(type, fileName);
      
      // Check if file exists
      const exists = await this.app.vault.adapter.exists(path);
      if (!exists) {
        return null;
      }
      
      // Read the file
      const content = await this.app.vault.adapter.read(path);
      
      // Parse as JSON if requested
      if (parseJson) {
        return JSON.parse(content) as T;
      }
      
      return content;
    } catch (error) {
      return null;
    }
  }
  
  /**
   * Delete a file
   * @param type Storage location type
   * @param fileName File name within the location
   * @returns Promise resolving to operation result
   */
  async deleteFile(
    type: StorageLocationType, 
    fileName: string
  ): Promise<StorageOperationResult> {
    try {
      // Get full path
      const path = this.getPath(type, fileName);
      
      // Check if file exists
      const exists = await this.app.vault.adapter.exists(path);
      if (!exists) {
        return { success: true, path }; // File doesn't exist, consider it deleted
      }
      
      // Delete the file
      await this.app.vault.adapter.remove(path);
      
      return { success: true, path };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMessage };
    }
  }
  
  /**
   * List files in a storage location
   * @param type Storage location type
   * @param subPath Optional sub-path within the location
   * @returns Promise resolving to array of file names
   */
  async listFiles(
    type: StorageLocationType, 
    subPath: string = ''
  ): Promise<string[]> {
    try {
      // Get full path
      const path = subPath ? this.getPath(type, subPath) : this.getPath(type);
      
      // Check if directory exists
      const exists = await this.app.vault.adapter.exists(path);
      if (!exists) {
        return [];
      }
      
      // List files
      const files = await this.app.vault.adapter.list(path);
      
      // Return only file names, not directories
      return files.files.map(f => f.split('/').pop() || '');
    } catch (error) {
      return [];
    }
  }
}
