import type { DataAdapter } from "obsidian";
import { desktopHost } from "../../platform/desktopOnly";
import { hasHostCapability } from "../../platform/hostCapabilities";

/** A published file version: its file stamp while it still holds the bytes written, null where none is known. */
export type StudioDocumentPublication = {fileStamp: string | null};

async function localFile(adapter: DataAdapter, path: string) {
  const desktop = adapter as DataAdapter & {getBasePath?: () => string};
  if (!hasHostCapability("local-filesystem") || typeof desktop.getBasePath !== "function") return null;
  const [fs, paths] = await Promise.all([desktopHost.fs(), desktopHost.path()]);
  const fullPath = paths.resolve(desktop.getBasePath(), path);
  const root = paths.resolve(desktop.getBasePath());
  if (!fullPath.startsWith(`${root}${paths.sep}`)) throw new Error("Studio path is outside the vault.");
  return {fs, paths, fullPath};
}

/** Modification time and size, which a rename keeps. A whole-millisecond time is too coarse
 * to tell a later same-size write from ours (HFS+, FAT, a copied time), so it gives none. */
function fileStampOf(stat: {mtimeMs: number; size: number}): string | null {
  return Number.isInteger(stat.mtimeMs) ? null : `${stat.mtimeMs}:${stat.size}`;
}

/** The file's current file stamp; null without a local file system, the file, or a precise time. */
export async function studioDocumentFileStamp(adapter: DataAdapter, path: string): Promise<string | null> {
  try {
    const local = await localFile(adapter, path);
    return local ? fileStampOf(await local.fs.stat(local.fullPath)) : null;
  } catch { return null; }
}

/** Desktop publication replaces one inode; the temporary sibling is removed on
 * failure and is never a second document, history file, or conflict copy.
 * False when the file no longer holds `expected`: a matching `expectedFileStamp`
 * proves it does without reading the file. */
export async function writeStudioDocumentAtomically(adapter: DataAdapter, path: string, expected: string, next: string, expectedFileStamp?: string): Promise<StudioDocumentPublication | false> {
  if (expected === next) return {fileStamp: expectedFileStamp ?? null};
  const local = await localFile(adapter, path);
  if (local) {
    const {fs, paths, fullPath} = local;
    const unchanged = async () => (expectedFileStamp !== undefined && fileStampOf(await fs.stat(fullPath)) === expectedFileStamp)
      || await fs.readFile(fullPath, "utf8") === expected;
    const temporary = paths.join(paths.dirname(fullPath), `.${paths.basename(fullPath)}.${window.crypto.randomUUID()}.tmp`);
    try {
      if (!await unchanged()) return false;
      const file = await fs.open(temporary, "wx", 0o600);
      let fileStamp: string | null;
      try { await file.writeFile(next, "utf8"); await file.sync(); fileStamp = fileStampOf(await file.stat()); } finally { await file.close(); }
      if (!await unchanged()) return false;
      await fs.rename(temporary, fullPath);
      return {fileStamp};
    } finally { await fs.rm(temporary, {force: true}); }
  }
  // Obsidian serializes adapter.process on non-desktop hosts. Atomic replacement
  // availability depends on the host adapter; the document format is identical.
  let matched = false;
  await adapter.process(path, current => {if (current !== expected) return current; matched = true; return next;});
  return matched ? {fileStamp: null} : false;
}
