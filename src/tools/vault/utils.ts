import { App, TFile, TFolder, normalizePath, type DataAdapter } from "obsidian";
import { desktopHost, hasNodeRuntime } from "../../platform/desktopOnly";
import { joinFilesystemPath } from "../../utils/vaultPathUtils";
import { toSafeVaultFileName } from "../../utils/vaultFileName";
import { FILESYSTEM_LIMITS } from "./constants";
export { fuzzyMatchScore } from "./searchUtils";

type VaultDataAdapter = DataAdapter & {
  getBasePath?: () => string;
};

type DesktopDirectoryEntry = {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
};

export type ConcurrencyFailure = {
  error: unknown;
  path: string;
};

/**
 * Utility functions for first-party vault tools.
 */

/**
 * Node `fs`/`path` are reached through the canonical desktop boundary so they
 * stay demand-loaded instead of adding work to plugin startup. Vault APIs
 * remain the fallback when an adapter does not expose an absolute base path.
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
 * Resolve a vault path to an absolute filesystem path for the Node fast-path
 * (desktop only). Returns null when there is no Node runtime or the adapter
 * exposes no base path — callers then fall back to the adapter API.
 */
export function resolveAdapterPath(adapter: VaultDataAdapter, vaultPath: string): string | null {
  if (!hasNodeRuntime() || !adapter || typeof adapter.getBasePath !== "function") return null;
  const basePath = adapter.getBasePath();
  if (!basePath) return null;
  const normalized = normalizeVaultPath(String(vaultPath ?? ""));
  if (!normalized) return basePath;
  if (normalized.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error("Path traversal detected: path escapes vault directory");
  }
  return joinFilesystemPath(basePath, normalized);
}

export async function ensureAdapterFolder(adapter: VaultDataAdapter, folderPath: string): Promise<void> {
  const fullPath = resolveAdapterPath(adapter, folderPath);
  const fsMod = fullPath ? await desktopHost.fs() : null;
  if (fullPath && fsMod) {
    await fsMod.mkdir(fullPath, { recursive: true });
    return;
  }
  // No-base-path adapter fallback: mkdir may be non-recursive, so build each
  // ancestor segment-by-segment, skipping ones that already exist (#142).
  if (adapter && typeof adapter.mkdir === "function") {
    const normalized = normalizeVaultPath(String(folderPath ?? ""));
    if (!normalized) return;
    const segments = normalized.split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      let exists = false;
      if (typeof adapter.exists === "function") {
        try {
          exists = await adapter.exists(current);
        } catch {
          exists = false;
        }
      }
      if (!exists) {
        try {
          await adapter.mkdir(current);
        } catch {
          // Tolerate races / "already exists" — a sibling op may have created it.
        }
      }
    }
  }
}

export async function adapterPathExists(adapter: VaultDataAdapter, vaultPath: string): Promise<boolean> {
  const fullPath = resolveAdapterPath(adapter, vaultPath);
  const fsMod = fullPath ? await desktopHost.fs() : null;
  if (fullPath && fsMod) {
    try {
      await fsMod.access(fullPath);
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

export async function readAdapterText(adapter: VaultDataAdapter, vaultPath: string): Promise<string> {
  const fullPath = resolveAdapterPath(adapter, vaultPath);
  const fsMod = fullPath ? await desktopHost.fs() : null;
  if (fullPath && fsMod) {
    return await fsMod.readFile(fullPath, "utf8");
  }
  if (adapter && typeof adapter.read === "function") {
    return await adapter.read(normalizeVaultPath(String(vaultPath ?? "")));
  }
  throw new Error("Adapter base path unavailable");
}

export async function writeAdapterText(adapter: VaultDataAdapter, vaultPath: string, content: string): Promise<void> {
  const fullPath = resolveAdapterPath(adapter, vaultPath);
  const fsMod = fullPath ? await desktopHost.fs() : null;
  if (fullPath && fsMod) {
    await fsMod.writeFile(fullPath, content, "utf8");
    return;
  }
  if (adapter && typeof adapter.write === "function") {
    await adapter.write(normalizeVaultPath(String(vaultPath ?? "")), content);
    return;
  }
  throw new Error("Adapter base path unavailable");
}

export async function statAdapterPath(adapter: VaultDataAdapter, vaultPath: string): Promise<{ size: number; ctime: number; mtime: number } | null> {
  const fullPath = resolveAdapterPath(adapter, vaultPath);
  const fsMod = fullPath ? await desktopHost.fs() : null;
  if (fullPath && fsMod) {
    const stat = await fsMod.stat(fullPath);
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

export async function listAdapterFiles(adapter: VaultDataAdapter, root: string): Promise<string[]> {
  const basePath = resolveAdapterPath(adapter, "");
  const rootPath = resolveAdapterPath(adapter, root);
  const fsMod = basePath && rootPath ? await desktopHost.fs() : null;
  if (basePath && rootPath && fsMod) {
    const files: string[] = [];
    const walk = async (dir: string) => {
      let entries: DesktopDirectoryEntry[];
      try {
        entries = await fsMod.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = joinFilesystemPath(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile()) {
          const rel = full
            .slice(basePath.replace(/[\\/]+$/, "").length)
            .replace(/^[\\/]+/, "")
            .replace(/\\/g, "/");
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

export async function listAdapterDirectory(adapter: VaultDataAdapter, dirPath: string): Promise<{ files: string[]; folders: string[] }> {
  const basePath = resolveAdapterPath(adapter, "");
  const fullPath = resolveAdapterPath(adapter, dirPath);
  const fsMod = basePath && fullPath ? await desktopHost.fs() : null;
  if (basePath && fullPath && fsMod) {
    const entries = await fsMod.readdir(fullPath, { withFileTypes: true });
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
 * Move a vault path on disk. Desktop uses the Node fast-path; adapter fallbacks
 * (no base path / no Node) rename through the adapter API (#142).
 */
export async function renameAdapterPath(adapter: VaultDataAdapter, sourcePath: string, destPath: string): Promise<void> {
  const sourceFull = resolveAdapterPath(adapter, sourcePath);
  const destFull = resolveAdapterPath(adapter, destPath);
  const fsMod = sourceFull && destFull ? await desktopHost.fs() : null;
  if (sourceFull && destFull && fsMod) {
    await fsMod.rename(sourceFull, destFull);
    return;
  }
  if (adapter && typeof adapter.rename === "function") {
    await adapter.rename(
      normalizeVaultPath(String(sourcePath ?? "")),
      normalizeVaultPath(String(destPath ?? "")),
    );
    return;
  }
  throw new Error("Adapter base path unavailable");
}


/**
 * Ensure a folder (and every missing ancestor) exists via the Vault API alone —
 * no Node required. Each ancestor is created segment-by-segment, skipping those
 * that already exist and tolerating "already exists" races, so a note write
 * never fails because a mid-level folder was missing (#142).
 */
export async function ensureVaultFolder(app: App, folderPath: string): Promise<void> {
  const normalized = normalizePath(normalizeVaultPath(String(folderPath ?? "")));
  if (!normalized || normalized === "/" || normalized === ".") return;

  const segments = normalized.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    const node = app.vault.getAbstractFileByPath(current);
    if (node instanceof TFolder) continue;
    if (node instanceof TFile) {
      throw new Error(`Cannot create folder "${current}": a file with that name already exists`);
    }
    try {
      await app.vault.createFolder(current);
    } catch (err) {
      // Tolerate a concurrent create: only rethrow if the folder truly isn't there.
      const after = app.vault.getAbstractFileByPath(current);
      if (!(after instanceof TFolder)) {
        throw err;
      }
    }
  }
}

/**
 * The path a create or move will actually produce. Segments that already
 * exist are kept exactly, so an agent can still address, overwrite or rename
 * a file whose name cannot sync. Every segment the call would create goes
 * through the shared vault file-name sanitizer. A sanitized name never lands
 * on an existing item the agent did not name: "a:b.md" beside an unrelated
 * "a b.md" becomes "a b 1.md".
 */
export function resolvePortableVaultPath(app: App, path: string): string {
  const resolved: string[] = [];
  let creating = false;
  for (const segment of path.split("/").filter(Boolean)) {
    if (segment === "." || segment === "..") {
      resolved.push(segment);
      continue;
    }
    if (!creating && app.vault.getAbstractFileByPath([...resolved, segment].join("/"))) {
      resolved.push(segment);
      continue;
    }
    const safe = toSafeVaultFileName(segment);
    // Only the first created segment can collide: everything after it lives
    // under a folder that did not exist.
    resolved.push(!creating && safe !== segment ? unusedSiblingName(app, resolved, safe) : safe);
    creating = true;
  }
  return resolved.join("/");
}

function unusedSiblingName(app: App, parent: readonly string[], name: string): string {
  const taken = (candidate: string) => app.vault.getAbstractFileByPath([...parent, candidate].join("/")) !== null;
  if (!taken(name)) return name;
  const match = /^(.+?)(\.[A-Za-z0-9]{1,16})?$/.exec(name);
  const stem = match?.[1] ?? name;
  const extension = match?.[2] ?? "";
  for (let suffix = 1; suffix <= 1_000; suffix += 1) {
    const candidate = `${stem} ${suffix}${extension}`;
    if (!taken(candidate)) return candidate;
  }
  throw new Error(`Could not find an unused name for "${name}".`);
}

/**
 * Tool results carry this under `notice`, which reaches the model intact;
 * error text does not. The agent must learn the path it should use next.
 */
export function portableVaultPathNotice(requested: string, actual: string): string {
  return `Used "${actual}" instead of "${requested}" because that name would not work on every device or in Obsidian Sync. `
    + "Names cannot contain : ? * \" < > | \\ # ^ [ ] or control characters, start with a dot or space, end with a dot or space, or be a reserved Windows name such as CON. "
    + `Use "${actual}" in later steps.`;
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
          }
        }
      }
      if (newLine !== undefined) {
        totalAdded++;
        if (!budgetExceeded) {
          if (!pushIfFits(`+ ${newLine}`)) {
            budgetExceeded = true;
            truncated = true;
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
): Promise<Array<T | ConcurrencyFailure>> {
  const ret: Array<T | ConcurrencyFailure> = [];
  let idx = 0;

  const runners = new Array(Math.min(concurrency, items.length)).fill(null).map(async () => {
    while (idx < items.length) {
      const current = items[idx++];
      try {
        ret.push(await worker(current));
      } catch (err) {
        // Propagate error as result shape for consistency
        ret.push({ error: err, path: current });
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
 * Determine whether adding `addition` (after stringifying) would exceed the
 * supplied character limit. Useful for building responses that must stay
 * under our model-safe threshold.
 */
export function wouldExceedCharLimit(currentSize: number, addition: unknown, limit: number): boolean {
  try {
    const additionSize = typeof addition === 'string' ? addition.length : JSON.stringify(addition).length;
    return currentSize + additionSize > limit;
  } catch {
    // Fallback in the odd case stringify fails – assume it would exceed.
    return true;
  }
}
