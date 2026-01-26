import { App, TFile, TFolder, normalizePath, Notice } from "obsidian";
import fs from "node:fs/promises";
import { 
  FileInfo, 
  DirectoryInfo, 
  CreateDirectoriesParams, 
  ListDirectoriesParams, 
  MoveItemsParams, 
  TrashFilesParams 
} from "../types";
import { FILESYSTEM_LIMITS } from "../constants";
import {
  validatePath,
  formatBytes,
  runWithConcurrency,
  shouldExcludeFromSearch,
  normalizeVaultPath,
  isHiddenSystemPath,
  ensureAdapterFolder,
  listAdapterDirectory,
  resolveAdapterPath,
  statAdapterPath,
} from "../utils";
import SystemSculptPlugin from "../../../main";

/**
 * Directory operations for MCP Filesystem tools
 */
export class DirectoryOperations {
  constructor(
    private app: App,
    private allowedPaths: string[],
    private plugin: SystemSculptPlugin
  ) {}

  private shouldUseAdapter(path: string): boolean {
    return isHiddenSystemPath(path);
  }

  /**
   * Create multiple directories
   */
  async createDirectories(params: CreateDirectoriesParams): Promise<{ results: Array<{ path: string, success: boolean, error?: string }> }> {
    const { paths } = params;
    
    // Limit operations to prevent resource exhaustion
    if (paths.length > FILESYSTEM_LIMITS.MAX_OPERATIONS) {
      throw new Error(`Too many directories requested (${paths.length}). Maximum allowed is ${FILESYSTEM_LIMITS.MAX_OPERATIONS}`);
    }
    
    const results = await Promise.all(paths.map(async (path: string) => {
      if (!validatePath(path, this.allowedPaths)) {
        return { path, success: false, error: `Access denied: ${path}` };
      }
      
      const normalizedPath = normalizePath(normalizeVaultPath(path));
      
      try {
        if (this.shouldUseAdapter(normalizedPath)) {
          const adapter: any = this.app.vault.adapter as any;
          await ensureAdapterFolder(adapter, normalizedPath);
        } else {
          await this.app.vault.createFolder(normalizedPath);
        }
        return { path, success: true };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        if (errorMessage.includes("already exists")) {
          return { path, success: true }; // Directory already exists
        }
        return { path, success: false, error: errorMessage };
      }
    }));
    return { results };
  }

  /**
   * List directory contents, with filtering, sorting, and optional recursion
   */
  async listDirectories(params: ListDirectoriesParams): Promise<{ results: Array<{ path: string, files?: FileInfo[], directories?: DirectoryInfo[], summary?: string, error?: string, suggestions?: string[] }> }> {
    const { paths } = params;
    const filter = (params as any).filter ?? "all";
    const sort = (params as any).sort ?? "modified";
    const recursive = (params as any).recursive ?? false;
    
    // Semantic filter is no longer supported - removed complex search engine
    if (typeof filter === 'object' && (filter as any).semantic) {
      return { results: [{ path: paths[0] || '', error: 'Semantic search has been disabled – use "Search Note Contents" instead' }] };
    }
    
    const results = await Promise.all(paths.map(async (path: string) => {
      try {
        if (!validatePath(path, this.allowedPaths)) {
          return { path, error: `Access denied: ${path}` };
        }
        
        const MAX_RESULTS = FILESYSTEM_LIMITS.MAX_SEARCH_RESULTS * 3; // Capped to ~75 items max to stay under 25k chars
        const normalizedPath = normalizePath(normalizeVaultPath(path));
        if (normalizedPath && this.shouldUseAdapter(normalizedPath)) {
          const adapter: any = this.app.vault.adapter as any;
          const pathResult: { path: string, files?: FileInfo[], directories?: DirectoryInfo[], summary?: string } = { path };

          if (filter === 'all' || filter === 'files') {
            pathResult.files = [];
          }
          if (filter === 'all' || filter === 'directories') {
            pathResult.directories = [];
          }

          const filePaths: string[] = [];
          const folderPaths: string[] = [];

          const collect = async (dir: string) => {
            let listing;
            try {
              listing = await listAdapterDirectory(adapter, dir);
            } catch {
              throw new Error(`Directory not found: ${path}`);
            }
            filePaths.push(...listing.files);
            folderPaths.push(...listing.folders);
            if (recursive) {
              for (const folderPath of listing.folders) {
                await collect(folderPath);
              }
            }
          };

          await collect(normalizedPath);

          const items = [
            ...filePaths.map((filePath) => ({ type: "file" as const, path: filePath })),
            ...folderPaths.map((folderPath) => ({ type: "folder" as const, path: folderPath })),
          ];

          const statCache = new Map<string, { size: number; ctime: number; mtime: number } | null>();

          const getStat = async (itemPath: string) => {
            if (statCache.has(itemPath)) return statCache.get(itemPath) || null;
            const stat = await statAdapterPath(adapter, itemPath);
            statCache.set(itemPath, stat);
            return stat;
          };

          await Promise.all(items.map(async (item) => {
            if (item.type === "file") {
              await getStat(item.path);
            }
          }));

          items.sort((a, b) => {
            const sortType = sort as "modified" | "size" | "name" | "created";
            if (sortType === "name") {
              return a.path.localeCompare(b.path);
            }

            const statA = statCache.get(a.path) || null;
            const statB = statCache.get(b.path) || null;

            if (sortType === "size") {
              const aSize = a.type === "file" ? (statA?.size || 0) : -1;
              const bSize = b.type === "file" ? (statB?.size || 0) : -1;
              return bSize - aSize;
            }

            if (sortType === "created") {
              const aCtime = a.type === "file" ? (statA?.ctime || 0) : 0;
              const bCtime = b.type === "file" ? (statB?.ctime || 0) : 0;
              return bCtime - aCtime;
            }

            const aMtime = a.type === "file" ? (statA?.mtime || 0) : 0;
            const bMtime = b.type === "file" ? (statB?.mtime || 0) : 0;
            return bMtime - aMtime;
          });

          const children = items.slice(0, MAX_RESULTS);

          let fileCount = 0;
          let dirCount = 0;
          let totalSize = 0;

          for (const child of children) {
            if (child.type === "file" && pathResult.files) {
              fileCount++;
              const stat = statCache.get(child.path) || null;
              const size = stat?.size ?? 0;
              totalSize += size;
              const name = child.path.split("/").pop() || child.path;
              pathResult.files.push({
                name,
                size,
                created: stat?.ctime ? new Date(stat.ctime).toISOString() : new Date().toISOString(),
                modified: stat?.mtime ? new Date(stat.mtime).toISOString() : new Date().toISOString(),
                extension: name.includes(".") ? name.split(".").pop() || "" : "",
              });
            } else if (child.type === "folder" && pathResult.directories) {
              dirCount++;
              let itemCount = 0;
              try {
                const listing = await listAdapterDirectory(adapter, child.path);
                itemCount = listing.files.length + listing.folders.length;
              } catch {
                itemCount = 0;
              }
              pathResult.directories.push({ name: child.path.split("/").pop() || child.path, itemCount });
            }
          }

          const totalItems = items.length;
          const itemsShown = Math.min(totalItems, MAX_RESULTS);
          if (totalItems > MAX_RESULTS) {
            pathResult.summary = `Showing ${itemsShown} of ${totalItems} items (${fileCount} files, ${dirCount} folders). Total size: ${formatBytes(totalSize)}. Sorted by: ${sort}${recursive ? ' (recursive)' : ''}`;
          } else {
            pathResult.summary = `${totalItems} items (${fileCount} files, ${dirCount} folders). Total size: ${formatBytes(totalSize)}. Sorted by: ${sort}${recursive ? ' (recursive)' : ''}`;
          }

          return pathResult;
        }
        const folder = normalizedPath ? this.app.vault.getAbstractFileByPath(normalizedPath) : this.app.vault.getRoot();
        
        if (!folder || !(folder instanceof TFolder)) {
          return { path, error: `Directory not found: ${path}` };
        }
        
        const pathResult: { path: string, files?: FileInfo[], directories?: DirectoryInfo[], summary?: string } = { path };

        if (filter === 'all' || filter === 'files') {
            pathResult.files = [];
        }
        if (filter === 'all' || filter === 'directories') {
            pathResult.directories = [];
        }

        // Collect all items (with recursion if needed)
        let allItems: (TFile | TFolder)[] = [];
        
        const collectItems = (folder: TFolder) => {
          for (const child of folder.children) {
            if (child instanceof TFile || child instanceof TFolder) {
              // Skip chat history and system files for files
              if (child instanceof TFile && shouldExcludeFromSearch(child, this.plugin)) {
                continue;
              }
              allItems.push(child);
              if (recursive && child instanceof TFolder) {
                collectItems(child);
              }
            }
          }
        };
        
        collectItems(folder);
        
        // Sort items based on the sort parameter
        allItems.sort((a, b) => {
          const sortType = sort as "modified" | "size" | "name" | "created";
          switch (sortType) {
            case "size":
              // Folders don't have size, put them last
              const aSize = a instanceof TFile ? a.stat.size : -1;
              const bSize = b instanceof TFile ? b.stat.size : -1;
              return bSize - aSize; // Largest first
            case "name":
              return a.name.localeCompare(b.name);
            case "created":
              const aCtime = a instanceof TFile ? a.stat.ctime : 0;
              const bCtime = b instanceof TFile ? b.stat.ctime : 0;
              return bCtime - aCtime; // Newest first
            case "modified":
            default:
              const aMtime = a instanceof TFile ? a.stat.mtime : 0;
              const bMtime = b instanceof TFile ? b.stat.mtime : 0;
              return bMtime - aMtime; // Newest first
          }
        });
        
        // Limit results to keep responses within transport budget
        const children = allItems.slice(0, MAX_RESULTS);

        let fileCount = 0;
        let dirCount = 0;
        let totalSize = 0;

        // Limit previews to avoid heavy IO
        const PREVIEW_MAX_FILES = 12;
        const PREVIEW_MAX_BYTES = 200 * 1024; // 200KB
        let previewsGenerated = 0;

        for (const child of children) {
            if (child instanceof TFile && pathResult.files) {
                fileCount++;
                totalSize += child.stat.size;
                
                // Get file metadata and preview
                const fileInfo: FileInfo = {
                  name: child.name,
                  size: child.stat.size,
                  created: new Date(child.stat.ctime).toISOString(),
                  modified: new Date(child.stat.mtime).toISOString(),
                  extension: child.extension
                };
                
                // Add preview for small text files, capped to a few items
                if (previewsGenerated < PREVIEW_MAX_FILES && (child.extension === 'md' || child.extension === 'txt' || child.extension === 'base') && (child.stat.size || 0) <= PREVIEW_MAX_BYTES) {
                  try {
                    const content = await this.app.vault.cachedRead(child);
                    // Get first non-empty line or first 150 chars
                    const lines = content.split('\n').filter(line => line.trim());
                    fileInfo.preview = lines[0] ? 
                      (lines[0].length > 150 ? lines[0].substring(0, 150) + '...' : lines[0]) : 
                      (content.length > 150 ? content.substring(0, 150) + '...' : content);
                    previewsGenerated++;
                  } catch {
                    // Ignore preview errors
                  }
                }
                
                pathResult.files.push(fileInfo);
            } else if (child instanceof TFolder && pathResult.directories) {
                dirCount++;
                
                // Get folder metadata
                const folderInfo: DirectoryInfo = {
                  name: child.name,
                  itemCount: child.children.length,
                  modified: undefined // Folders don't have stat in Obsidian API
                };
                
                pathResult.directories.push(folderInfo);
            }
        }
        
        // Add summary with visibility note when capped
        const totalItems = allItems.length;
        const itemsShown = Math.min(totalItems, MAX_RESULTS);
        if (totalItems > MAX_RESULTS) {
          pathResult.summary = `Showing ${itemsShown} of ${totalItems} items (${fileCount} files, ${dirCount} folders). Total size: ${formatBytes(totalSize)}. Sorted by: ${sort}${recursive ? ' (recursive)' : ''}`;
        } else {
          pathResult.summary = `${totalItems} items (${fileCount} files, ${dirCount} folders). Total size: ${formatBytes(totalSize)}. Sorted by: ${sort}${recursive ? ' (recursive)' : ''}`;
        }
        
        return pathResult;
      } catch (error) {
        return { path, error: error instanceof Error ? error.message : 'Unknown error' };
      }
    }));

    return { results };
  }

  /**
   * Move or rename multiple files/folders
   */
  async moveItems(params: MoveItemsParams): Promise<{ results: Array<{ source: string, destination: string, success: boolean, error?: string }> }> {
    const { items } = params;
    
    // Enforce global safety cap
    if (items.length > FILESYSTEM_LIMITS.MAX_OPERATIONS) {
      throw new Error(`Cannot move more than ${FILESYSTEM_LIMITS.MAX_OPERATIONS} items at once.`);
    }

    const results: Array<{ source: string, destination: string, success: boolean, error?: string }> = [];

    // Process in small batches to keep UI responsive and avoid file-lock contention
    const CHUNK_SIZE = 5; // keep individual operations small; aligns with previous per-call limit
    for (let i = 0; i < items.length; i += CHUNK_SIZE) {
      const chunk = items.slice(i, i + CHUNK_SIZE);
      // Run this chunk serially to preserve predictable ordering
      /* eslint-disable no-await-in-loop */
      for (const { source, destination } of chunk) {
        try {
          // Validate paths
          if (!validatePath(source, this.allowedPaths)) {
            throw new Error(`Access denied: ${source}`);
          }
          if (!validatePath(destination, this.allowedPaths)) {
            throw new Error(`Access denied: ${destination}`);
          }

          if (this.shouldUseAdapter(source) || this.shouldUseAdapter(destination)) {
            const adapter: any = this.app.vault.adapter as any;
            const sourceFull = resolveAdapterPath(adapter, source);
            const destFull = resolveAdapterPath(adapter, destination);
            if (!sourceFull || !destFull) {
              throw new Error("Adapter base path unavailable");
            }
            const destFolder = destination.split("/").slice(0, -1).join("/");
            if (destFolder) {
              await ensureAdapterFolder(adapter, destFolder);
            }
            await fs.rename(sourceFull, destFull);
            results.push({ source, destination, success: true });
            continue;
          }

          const normalizedSource = normalizePath(normalizeVaultPath(source));
          const normalizedDestination = normalizePath(normalizeVaultPath(destination));

          // Get the source file/folder
          const sourceFile = this.app.vault.getAbstractFileByPath(normalizedSource);
          if (!sourceFile) {
            throw new Error(`Item not found: ${source}`);
          }

          // Move/rename operation
          await this.app.fileManager.renameFile(sourceFile, normalizedDestination);
          results.push({ source, destination, success: true });
        } catch (error: any) {
          results.push({ source, destination, success: false, error: error?.message || String(error) });
        }
      }
      /* eslint-enable no-await-in-loop */
    }

    // User feedback summary
    const ok = results.filter(r => r.success).length;
    const failed = results.length - ok;
    try {
      if (ok > 0) new Notice(`Moved ${ok} item${ok === 1 ? '' : 's'}${failed ? ` (${failed} failed)` : ''}.`);
    } catch {}

    return { results };
  }

  /**
   * Move multiple files/folders to trash
   */
  async trashFiles(params: TrashFilesParams): Promise<{ results: Array<{ path: string, success: boolean, error?: string }> }> {
    const { paths } = params;
    
    // Enforce safety cap to avoid overwhelming the file-system
    if (paths.length > FILESYSTEM_LIMITS.MAX_OPERATIONS) {
      throw new Error(`Cannot trash more than ${FILESYSTEM_LIMITS.MAX_OPERATIONS} items at once.`);
    }

    // Execute trash operations with limited concurrency to reduce IO contention
    const settled = await runWithConcurrency(paths, async (p) => {
      await this.trashFile(p);
      return { path: p, success: true };
    });

    // Normalise results & map errors
    const results = settled.map((res) => {
      if (res && (res as any).success) return res as { path: string; success: boolean };
      // An error was caught – convert to typed result object
      const errObj = res as any;
      return {
        path: errObj?.path ?? "<unknown>",
        success: false,
        error: errObj?.error?.message ?? errObj?.message ?? String(errObj)
      };
    });

    const successfulCount = results.filter(r => r.success).length;
    if (successfulCount > 0) {
      new Notice(`Moved ${successfulCount} item(s) to trash.`);
    }

    return { results };
  }

  /**
   * Move a file/folder to trash
   */
  private async trashFile(path: string): Promise<{ path: string, success: boolean }> {
    if (!validatePath(path, this.allowedPaths)) {
      throw new Error(`Access denied: ${path}`);
    }

    if (this.shouldUseAdapter(path)) {
      const adapter: any = this.app.vault.adapter as any;
      const fullPath = resolveAdapterPath(adapter, path);
      if (!fullPath) {
        throw new Error("Adapter base path unavailable");
      }
      await fs.rm(fullPath, { recursive: true, force: true });
      return { path, success: true };
    }
    
    // Get the file/folder
    const normalizedPath = normalizePath(normalizeVaultPath(path));
    const file = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (!file) {
      throw new Error(`File not found: ${path}`);
    }
    
    // Move to Obsidian's .trash folder using vault adapter
    const adapterPath = normalizePath(normalizeVaultPath(file.path));
    await this.app.vault.adapter.trashLocal(adapterPath);
    
    return { path, success: true };
  }
}
