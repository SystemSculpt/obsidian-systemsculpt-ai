import { App, TFile, TFolder, normalizePath, Notice } from "obsidian";
import {
  FileInfo,
  DirectoryInfo,
  ListDirectoryResult,
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
  ensureVaultFolder,
  listAdapterDirectory,
  renameAdapterPath,
  statAdapterPath,
} from "../utils";
import SystemSculptPlugin from "../../../main";
import { resolveFolderNotePath } from "../folderNotes";

/**
 * Directory operations for first-party vault tools.
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
  async listDirectories(params: ListDirectoriesParams): Promise<{ results: ListDirectoryResult[] }> {
    const { paths } = params;
    const filter = (params as any).filter ?? "all";
    const sort = (params as any).sort ?? "modified";
    const recursive = (params as any).recursive ?? false;
    const offset = Math.max(0, Math.floor(Number((params as any).offset ?? 0) || 0));
    const defaultPageSize = FILESYSTEM_LIMITS.DEFAULT_LIST_PAGE_SIZE ?? 25;
    const maxPageSize = FILESYSTEM_LIMITS.MAX_LIST_PAGE_SIZE ?? 50;
    const requestedLimit = Math.floor(Number((params as any).limit ?? defaultPageSize) || defaultPageSize);
    const limit = Math.max(1, Math.min(maxPageSize, requestedLimit));

    if (!Array.isArray(paths) || paths.length === 0) {
      throw new Error("Missing required 'paths'. Provide one or more directory paths.");
    }
    if (paths.length > 5) {
      throw new Error("Cannot list more than 5 directories at once.");
    }
    const pageOrders = new WeakMap<ListDirectoryResult, Array<{ type: "file" | "folder"; path: string }>>();
    
    // Semantic filter is no longer supported - removed complex search engine
    if (typeof filter === 'object' && (filter as any).semantic) {
      return { results: [{
        path: paths[0] || '',
        error: 'Semantic search has been disabled – use "Search Note Contents" instead',
        offset,
        totalItems: 0,
        nextOffset: null,
      }] };
    }
    
    const results = await Promise.all(paths.map(async (path: string) => {
      try {
        if (!validatePath(path, this.allowedPaths)) {
          return { path, error: `Access denied: ${path}`, offset, totalItems: 0, nextOffset: null };
        }
        
        const MAX_RESULTS = FILESYSTEM_LIMITS.MAX_SEARCH_RESULTS * 3; // Capped to ~75 items max to stay under 25k chars
        const normalizedCandidate = normalizePath(normalizeVaultPath(path));
        const normalizedPath = normalizedCandidate === "." ? "" : normalizedCandidate;
        if (normalizedPath && this.shouldUseAdapter(normalizedPath)) {
          const adapter: any = this.app.vault.adapter as any;
          const pathResult: ListDirectoryResult = { path, offset, totalItems: 0, nextOffset: null };

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
          ].filter((item) => filter === "all" || filter === "files" && item.type === "file" || filter === "directories" && item.type === "folder");

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
              return bSize - aSize || a.path.localeCompare(b.path);
            }

            if (sortType === "created") {
              const aCtime = a.type === "file" ? (statA?.ctime || 0) : 0;
              const bCtime = b.type === "file" ? (statB?.ctime || 0) : 0;
              return bCtime - aCtime || a.path.localeCompare(b.path);
            }

            const aMtime = a.type === "file" ? (statA?.mtime || 0) : 0;
            const bMtime = b.type === "file" ? (statB?.mtime || 0) : 0;
            return bMtime - aMtime || a.path.localeCompare(b.path);
          });

          const effectiveLimit = Math.min(limit, MAX_RESULTS);
          const children = items.slice(offset, offset + effectiveLimit);
          pageOrders.set(pathResult, children.map((child) => ({ type: child.type, path: child.path })));

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
                path: child.path,
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
              pathResult.directories.push({ path: child.path, name: child.path.split("/").pop() || child.path, itemCount });
            }
          }

          const totalItems = items.length;
          const itemsShown = children.length;
          pathResult.totalItems = totalItems;
          pathResult.nextOffset = offset + itemsShown < totalItems ? offset + itemsShown : null;
          pathResult.summary = `Showing ${itemsShown} of ${totalItems} items from offset ${offset} (${fileCount} files, ${dirCount} folders). Total size: ${formatBytes(totalSize)}. Sorted by: ${sort}${recursive ? ' (recursive)' : ''}`;

          return pathResult;
        }
        const folder = normalizedPath ? this.app.vault.getAbstractFileByPath(normalizedPath) : this.app.vault.getRoot();
        
        if (!folder || !(folder instanceof TFolder)) {
          return { path, error: `Directory not found: ${path}`, offset, totalItems: 0, nextOffset: null };
        }
        
        const pathResult: ListDirectoryResult = { path, offset, totalItems: 0, nextOffset: null };

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
        allItems = allItems.filter((item) =>
          filter === "all"
          || filter === "files" && item instanceof TFile
          || filter === "directories" && item instanceof TFolder
        );
        
        // Sort items based on the sort parameter
        allItems.sort((a, b) => {
          const sortType = sort as "modified" | "size" | "name" | "created";
          switch (sortType) {
            case "size":
              // Folders don't have size, put them last
              const aSize = a instanceof TFile ? a.stat.size : -1;
              const bSize = b instanceof TFile ? b.stat.size : -1;
              return bSize - aSize || a.path.localeCompare(b.path); // Largest first
            case "name":
              return a.path.localeCompare(b.path);
            case "created":
              const aCtime = a instanceof TFile ? a.stat.ctime : 0;
              const bCtime = b instanceof TFile ? b.stat.ctime : 0;
              return bCtime - aCtime || a.path.localeCompare(b.path); // Newest first
            case "modified":
            default:
              const aMtime = a instanceof TFile ? a.stat.mtime : 0;
              const bMtime = b instanceof TFile ? b.stat.mtime : 0;
              return bMtime - aMtime || a.path.localeCompare(b.path); // Newest first
          }
        });
        
        // Limit results to keep responses within transport budget
        const effectiveLimit = Math.min(limit, MAX_RESULTS);
        const children = allItems.slice(offset, offset + effectiveLimit);
        pageOrders.set(pathResult, children.map((child) => ({
          type: child instanceof TFile ? "file" : "folder",
          path: child.path,
        })));

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
                  path: child.path,
                  name: child.name,
                  size: child.stat.size,
                  created: new Date(child.stat.ctime).toISOString(),
                  modified: new Date(child.stat.mtime).toISOString(),
                  extension: child.extension
                };
                
                // Add preview for small text files, capped to a few items
                if (previewsGenerated < PREVIEW_MAX_FILES && (child.extension === 'md' || child.extension === 'txt' || child.extension === 'base' || child.extension === 'systemsculpt') && (child.stat.size || 0) <= PREVIEW_MAX_BYTES) {
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
                  path: child.path,
                  name: child.name,
                  itemCount: child.children.length,
                  modified: undefined // Folders don't have stat in Obsidian API
                };
                
                pathResult.directories.push(folderInfo);
            }
        }
        
        // Add summary with visibility note when capped
        const totalItems = allItems.length;
        const itemsShown = children.length;
        pathResult.totalItems = totalItems;
        pathResult.nextOffset = offset + itemsShown < totalItems ? offset + itemsShown : null;
        pathResult.summary = `Showing ${itemsShown} of ${totalItems} items from offset ${offset} (${fileCount} files, ${dirCount} folders). Total size: ${formatBytes(totalSize)}. Sorted by: ${sort}${recursive ? ' (recursive)' : ''}`;
        
        return pathResult;
      } catch (error) {
        return { path, error: error instanceof Error ? error.message : 'Unknown error', offset, totalItems: 0, nextOffset: null };
      }
    }));

    this.enforceListResponseBudget(results, pageOrders);
    return { results };
  }

  private enforceListResponseBudget(
    results: ListDirectoryResult[],
    pageOrders: WeakMap<ListDirectoryResult, Array<{ type: "file" | "folder"; path: string }>>,
  ): void {
    const maxChars = FILESYSTEM_LIMITS.MAX_RESPONSE_CHARS ?? 25000;
    let serializedLength = JSON.stringify({ results }).length;
    if (serializedLength <= maxChars) return;

    for (let resultIndex = results.length - 1; resultIndex >= 0 && serializedLength > maxChars; resultIndex -= 1) {
      for (const file of [...(results[resultIndex].files ?? [])].reverse()) {
        if (serializedLength <= maxChars) break;
        if (file.preview) delete file.preview;
        serializedLength = JSON.stringify({ results }).length;
      }
    }

    while (serializedLength > maxChars) {
      const target = [...results].reverse().find((result) =>
        (result.files?.length ?? 0) + (result.directories?.length ?? 0) > 0
      );
      if (!target) break;
      const pageOrder = pageOrders.get(target);
      const last = pageOrder?.pop();
      if (last?.type === "file") {
        const index = target.files?.map((file) => file.path).lastIndexOf(last.path) ?? -1;
        if (index >= 0) target.files!.splice(index, 1);
      } else if (last?.type === "folder") {
        const index = target.directories?.map((directory) => directory.path).lastIndexOf(last.path) ?? -1;
        if (index >= 0) target.directories!.splice(index, 1);
      } else if ((target.directories?.length ?? 0) > 0) {
        target.directories!.pop();
      } else {
        target.files!.pop();
      }
      const shown = (target.files?.length ?? 0) + (target.directories?.length ?? 0);
      target.nextOffset = target.offset + shown < target.totalItems ? target.offset + shown : null;
      target.summary = `Showing ${shown} of ${target.totalItems} items from offset ${target.offset}; response capped for agent context.`;
      serializedLength = JSON.stringify({ results }).length;
    }
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
            const destFolder = destination.split("/").slice(0, -1).join("/");
            if (destFolder) {
              await ensureAdapterFolder(adapter, destFolder);
            }
            // Desktop uses the Node fast-path; adapter fallbacks rename through the adapter.
            await renameAdapterPath(adapter, source, destination);
            results.push({ source, destination, success: true });
            continue;
          }

          const normalizedSource = normalizePath(normalizeVaultPath(source));
          const normalizedDestination = normalizePath(normalizeVaultPath(destination));

          // Get the source file/folder, falling back to the Folder Notes
          // layout (X.md -> X/X.md) so moves work on folder notes too (#154).
          let sourceFile = this.app.vault.getAbstractFileByPath(normalizedSource);
          if (!sourceFile) {
            const folderNotePath = resolveFolderNotePath(this.app, normalizedSource);
            if (folderNotePath) {
              sourceFile = this.app.vault.getAbstractFileByPath(folderNotePath);
            }
          }
          if (!sourceFile) {
            throw new Error(`Item not found: ${source}`);
          }

          const destinationParent = normalizedDestination.split("/").slice(0, -1).join("/");
          if (destinationParent) {
            await ensureVaultFolder(this.app, destinationParent);
          }

          // Move/rename operation
          await this.app.fileManager.renameFile(sourceFile, normalizedDestination);
          results.push({ source, destination, success: true });
        } catch (error: any) {
          results.push({ source, destination, success: false, error: error?.message || String(error) });
        }
      }

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

    // Get the file/folder, falling back to the Folder Notes layout
    // (X.md -> X/X.md) so trashing works on folder notes too (#154).
    const normalizedPath = normalizePath(normalizeVaultPath(path));
    if (normalizedPath === ".systemsculpt" || this.shouldUseAdapter(normalizedPath)) {
      throw new Error(`Access denied: internal SystemSculpt paths cannot be moved to trash (${path})`);
    }
    let file = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (!file) {
      const folderNotePath = resolveFolderNotePath(this.app, normalizedPath);
      if (folderNotePath) {
        file = this.app.vault.getAbstractFileByPath(folderNotePath);
      }
    }
    if (!file) {
      throw new Error(`File not found: ${path}`);
    }
    
    // Move to Obsidian's .trash folder using vault adapter
    const adapterPath = normalizePath(normalizeVaultPath(file.path));
    await this.app.vault.adapter.trashLocal(adapterPath);
    
    return { path, success: true };
  }
}
