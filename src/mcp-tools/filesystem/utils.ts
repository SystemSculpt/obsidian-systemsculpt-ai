import { App, TFile, TFolder, normalizePath } from "obsidian";
import path from "node:path";
import fs from "node:fs/promises";
import { FILESYSTEM_LIMITS } from "./constants";
export { fuzzyMatchScore, shouldExcludeFromSearch } from "./searchUtils";

/**
 * Utility functions for MCP Filesystem tools
 */

/**
 * Format bytes to human readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function normalizeVaultPath(value: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  // People (and models) sometimes copy paths from Obsidian URIs (or other URL-encoded sources),
  // which turns spaces into `%20` and slashes into `%2F`. Decode those so tool calls work with
  // vault paths like `My Folder/My Note.md` even if the input was encoded.
  let decoded = raw;
  for (let i = 0; i < 2; i++) {
    if (!/%[0-9A-Fa-f]{2}/.test(decoded)) break;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }

  return decoded
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

export function isHiddenSystemPath(path: string): boolean {
  const raw = String(path ?? "").trim();
  if (!raw) return false;
  const normalized = normalizeVaultPath(raw);
  return normalized.startsWith(".systemsculpt/");
}

/**
 * Ensures a resolved path stays within the base directory.
 * Throws an error if the path would escape the base directory via traversal sequences.
 */
function assertWithinBase(basePath: string, resolvedPath: string): void {
  const realBase = path.resolve(basePath);
  const realResolved = path.resolve(resolvedPath);

  // Allow exact match (accessing base directory itself)
  if (realResolved === realBase) return;

  // Ensure resolved path is within base (with path separator to prevent prefix attacks)
  if (!realResolved.startsWith(realBase + path.sep)) {
    throw new Error("Path traversal detected: path escapes vault directory");
  }
}

export function resolveAdapterPath(adapter: any, vaultPath: string): string | null {
  if (!adapter || typeof adapter.getBasePath !== "function") return null;
  const basePath = adapter.getBasePath();
  if (!basePath) return null;
  const normalized = normalizeVaultPath(String(vaultPath ?? ""));
  if (!normalized) return basePath;

  const resolved = path.join(basePath, normalized);
  assertWithinBase(basePath, resolved);
  return resolved;
}

export async function ensureAdapterFolder(adapter: any, folderPath: string): Promise<void> {
  const fullPath = resolveAdapterPath(adapter, folderPath);
  if (fullPath) {
    await fs.mkdir(fullPath, { recursive: true });
    return;
  }
  if (adapter && typeof adapter.mkdir === "function") {
    const normalized = normalizeVaultPath(String(folderPath ?? ""));
    if (normalized) {
      await adapter.mkdir(normalized);
    }
  }
}

export async function adapterPathExists(adapter: any, vaultPath: string): Promise<boolean> {
  const fullPath = resolveAdapterPath(adapter, vaultPath);
  if (fullPath) {
    try {
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }
  if (adapter && typeof adapter.exists === "function") {
    try {
      return await adapter.exists(normalizeVaultPath(String(vaultPath ?? "")));
    } catch {
      return false;
    }
  }
  return false;
}

export async function readAdapterText(adapter: any, vaultPath: string): Promise<string> {
  const fullPath = resolveAdapterPath(adapter, vaultPath);
  if (fullPath) {
    return await fs.readFile(fullPath, "utf8");
  }
  if (adapter && typeof adapter.read === "function") {
    return await adapter.read(normalizeVaultPath(String(vaultPath ?? "")));
  }
  throw new Error("Adapter base path unavailable");
}

export async function writeAdapterText(adapter: any, vaultPath: string, content: string): Promise<void> {
  const fullPath = resolveAdapterPath(adapter, vaultPath);
  if (fullPath) {
    await fs.writeFile(fullPath, content, "utf8");
    return;
  }
  if (adapter && typeof adapter.write === "function") {
    await adapter.write(normalizeVaultPath(String(vaultPath ?? "")), content);
    return;
  }
  throw new Error("Adapter base path unavailable");
}

export async function statAdapterPath(adapter: any, vaultPath: string): Promise<{ size: number; ctime: number; mtime: number } | null> {
  const fullPath = resolveAdapterPath(adapter, vaultPath);
  if (fullPath) {
    const stat = await fs.stat(fullPath);
    return { size: stat.size, ctime: stat.ctimeMs, mtime: stat.mtimeMs };
  }
  if (adapter && typeof adapter.stat === "function") {
    try {
      const stat = await adapter.stat(normalizeVaultPath(String(vaultPath ?? "")));
      if (!stat) return null;
      return { size: stat.size ?? 0, ctime: stat.ctime ?? Date.now(), mtime: stat.mtime ?? Date.now() };
    } catch {
      return null;
    }
  }
  return null;
}

export async function listAdapterFiles(adapter: any, root: string): Promise<string[]> {
  const basePath = resolveAdapterPath(adapter, "");
  const rootPath = resolveAdapterPath(adapter, root);
  if (basePath && rootPath) {
    const files: string[] = [];
    const walk = async (dir: string) => {
      let entries: Array<import("node:fs").Dirent>;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile()) {
          const rel = path.relative(basePath, full).split(path.sep).join("/");
          files.push(rel);
        }
      }
    };

    await walk(rootPath);
    return files;
  }

  if (!adapter || typeof adapter.list !== "function") return [];
  const normalizedRoot = normalizeVaultPath(String(root ?? ""));
  if (!normalizedRoot) return [];
  const files: string[] = [];
  const walk = async (dir: string) => {
    let listing;
    try {
      listing = await adapter.list(dir);
    } catch {
      return;
    }
    const listingFiles: string[] = Array.isArray(listing?.files) ? listing.files : [];
    const listingFolders: string[] = Array.isArray(listing?.folders) ? listing.folders : [];
    files.push(...listingFiles);
    for (const folder of listingFolders) {
      await walk(folder);
    }
  };
  await walk(normalizedRoot);
  return files;
}

export async function listAdapterDirectory(adapter: any, dirPath: string): Promise<{ files: string[]; folders: string[] }> {
  const basePath = resolveAdapterPath(adapter, "");
  const fullPath = resolveAdapterPath(adapter, dirPath);
  if (basePath && fullPath) {
    const entries = await fs.readdir(fullPath, { withFileTypes: true });
    const normalizedDir = normalizeVaultPath(String(dirPath ?? ""));
    const files: string[] = [];
    const folders: string[] = [];
    for (const entry of entries) {
      const childPath = normalizedDir ? `${normalizedDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        folders.push(childPath);
      } else if (entry.isFile()) {
        files.push(childPath);
      }
    }
    return { files, folders };
  }

  if (adapter && typeof adapter.list === "function") {
    const listing = await adapter.list(normalizeVaultPath(String(dirPath ?? "")));
    return {
      files: Array.isArray(listing?.files) ? listing.files : [],
      folders: Array.isArray(listing?.folders) ? listing.folders : [],
    };
  }

  throw new Error("Adapter base path unavailable");
}

/**
 * Validate that a path is allowed within the given allowed paths
 */
export function validatePath(path: string, allowedPaths: string[]): boolean {
  const normalizedPath = normalizePath(normalizeVaultPath(path));
  if (normalizedPath.length === 0) {
    return allowedPaths.some((allowedPath) => {
      const allowedNormalized = normalizePath(normalizeVaultPath(String(allowedPath ?? "")));
      return allowedNormalized.length === 0 || allowedPath === "/";
    });
  }
  
  // Check if path is within allowed paths
  for (const allowedPath of allowedPaths) {
    if (allowedPath === "/") {
      return true;
    }
    const allowedNormalized = normalizePath(normalizeVaultPath(String(allowedPath ?? "")));
    if (!allowedNormalized) {
      return true;
    }
    if (normalizedPath === allowedNormalized || normalizedPath.startsWith(`${allowedNormalized}/`)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Normalize line endings for consistent handling
 */
export function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/**
 * Create a simple diff summary for preview
 */
export function createSimpleDiff(originalContent: string, newContent: string, filepath: string = 'file'): string {
  const normalizedOriginal = normalizeLineEndings(originalContent);
  const normalizedNew = normalizeLineEndings(newContent);
  
  if (normalizedOriginal === normalizedNew) {
    return "No changes made.";
  }
  
  const originalLines = normalizedOriginal.split('\n');
  const newLines = normalizedNew.split('\n');
  
  let diffLines: string[] = [];
  diffLines.push(`--- ${filepath}`);
  diffLines.push(`+++ ${filepath}`);

  // Line-by-line comparison with character budget
  const maxLines = Math.max(originalLines.length, newLines.length);
  let shownAdded = 0;
  let shownRemoved = 0;
  let totalAdded = 0;
  let totalRemoved = 0;

  const MAX_CHARS = FILESYSTEM_LIMITS.MAX_RESPONSE_CHARS;
  const SUMMARY_RESERVE = 256; // space for footer
  const HEADER_LEN = diffLines.join('\n').length + 1; // include newline
  let used = HEADER_LEN;

  const pushIfFits = (line: string) => {
    const need = line.length + 1; // newline
    if (used + need <= (MAX_CHARS - SUMMARY_RESERVE)) {
      diffLines.push(line);
      used += need;
      return true;
    }
    return false;
  };

  let budgetExceeded = false;
  let truncated = false;
  for (let i = 0; i < maxLines; i++) {
    const oldLine = originalLines[i];
    const newLine = newLines[i];

    if (oldLine !== newLine) {
      if (oldLine !== undefined) {
        totalRemoved++;
        if (!budgetExceeded) {
          if (!pushIfFits(`- ${oldLine}`)) {
            budgetExceeded = true;
            truncated = true;
          } else {
            shownRemoved++;
          }
        }
      }
      if (newLine !== undefined) {
        totalAdded++;
        if (!budgetExceeded) {
          if (!pushIfFits(`+ ${newLine}`)) {
            budgetExceeded = true;
            truncated = true;
          } else {
            shownAdded++;
          }
        }
      }
    }
  }

  const summarySuffix = truncated ? ` (truncated to ${FILESYSTEM_LIMITS.MAX_RESPONSE_CHARS} chars)` : '';
  return diffLines.join('\n') + `\n\nSummary: +${totalAdded} -${totalRemoved} lines${summarySuffix}`;
}

/**
 * Helper to run a set of promises with limited parallelism
 */
export async function runWithConcurrency<T>(
  items: string[], 
  worker: (item: string) => Promise<T>, 
  concurrency = 10
): Promise<T[]> {
  const ret: T[] = [];
  let idx = 0;

  const runners = new Array(Math.min(concurrency, items.length)).fill(null).map(async () => {
    while (idx < items.length) {
      const current = items[idx++];
      try {
        ret.push(await worker(current));
      } catch (err) {
        // Propagate error as result shape for consistency
        ret.push({ error: err, path: current } as any);
      }
    }
  });

  await Promise.all(runners);
  return ret;
}

/**
 * Create a line number calculator for efficient line lookup
 */
export function createLineCalculator(content: string): (index: number) => number {
  const lineStarts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      lineStarts.push(i + 1);
    }
  }
  
  return (index: number): number => {
    // Binary search for line number
    let left = 0;
    let right = lineStarts.length - 1;
    
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const start = lineStarts[mid];
      const end = mid < lineStarts.length - 1 ? lineStarts[mid + 1] : content.length;
      
      if (index >= start && index < end) {
        return mid + 1;
      } else if (index < start) {
        right = mid - 1;
      } else {
        left = mid + 1;
      }
    }
    
    return lineStarts.length; // Fallback
  };
}

/**
 * Get all files from a folder recursively
 */
export function getFilesFromFolder(folder: TFolder): TFile[] {
  const files: TFile[] = [];
  const processFolder = (currentFolder: TFolder) => {
    for (const child of currentFolder.children) {
      if (child instanceof TFile) {
        files.push(child);
      } else if (child instanceof TFolder) {
        processFolder(child);
      }
    }
  };
  processFolder(folder);
  return files;
}

/**
 * Evaluate metadata query
 */
export function evaluateQuery(actualValue: any, operator: string, expectedValue: any): boolean {
  // Attempt to parse dates for comparison
  const dActual = new Date(actualValue);
  const dExpected = new Date(expectedValue);

  const isDateComparison = !isNaN(dActual.getTime()) && !isNaN(dExpected.getTime());

  if (isDateComparison) {
    actualValue = dActual;
    expectedValue = dExpected;
  }

  switch (operator) {
    case 'equals':
      return actualValue == expectedValue;
    case 'not_equals':
      return actualValue != expectedValue;
    case 'contains':
      if (Array.isArray(actualValue)) return actualValue.includes(expectedValue);
      if (typeof actualValue === 'string') return actualValue.includes(expectedValue);
      return false;
    case 'starts_with':
      if (typeof actualValue === 'string') return actualValue.startsWith(expectedValue);
      return false;
    case 'greater_than':
      return actualValue > expectedValue;
    case 'less_than':
      return actualValue < expectedValue;
    default:
      return false;
  }
}

/**
 * Determine whether adding `addition` (after stringifying) would exceed the
 * supplied character limit. Useful for building responses that must stay
 * under our model-safe threshold.
 */
export function wouldExceedCharLimit(currentSize: number, addition: any, limit: number): boolean {
  try {
    const additionSize = typeof addition === 'string' ? addition.length : JSON.stringify(addition).length;
    return currentSize + additionSize > limit;
  } catch {
    // Fallback in the odd case stringify fails – assume it would exceed.
    return true;
  }
}
