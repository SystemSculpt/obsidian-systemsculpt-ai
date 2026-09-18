import type { DataAdapter } from "obsidian";
import { desktopHost } from "../../platform/desktopOnly";
import { hasHostCapability } from "../../platform/hostCapabilities";

/** Desktop publication replaces one inode; the temporary sibling is removed on
 * failure and is never a second document, history file, or conflict copy. */
export async function writeStudioDocumentAtomically(adapter: DataAdapter, path: string, expected: string, next: string): Promise<boolean> {
  if (expected === next) return true;
  const desktop = adapter as DataAdapter & {getBasePath?: () => string};
  if (hasHostCapability("local-filesystem") && typeof desktop.getBasePath === "function") {
    const [fs, paths] = await Promise.all([desktopHost.fs(), desktopHost.path()]);
    const fullPath = paths.resolve(desktop.getBasePath(), path);
    const root = paths.resolve(desktop.getBasePath());
    if (!fullPath.startsWith(`${root}${paths.sep}`)) throw new Error("Studio path is outside the vault.");
    const temporary = paths.join(paths.dirname(fullPath), `.${paths.basename(fullPath)}.${window.crypto.randomUUID()}.tmp`);
    try {
      if (await fs.readFile(fullPath, "utf8") !== expected) return false;
      const file = await fs.open(temporary, "wx", 0o600);
      try { await file.writeFile(next, "utf8"); await file.sync(); } finally { await file.close(); }
      if (await fs.readFile(fullPath, "utf8") !== expected) return false;
      await fs.rename(temporary, fullPath);
      return true;
    } finally { await fs.rm(temporary, {force: true}); }
  }
  // Obsidian serializes adapter.process on non-desktop hosts. Atomic replacement
  // availability depends on the host adapter; the document format is identical.
  let matched = false;
  await adapter.process(path, current => {if (current !== expected) return current; matched = true; return next;});
  return matched;
}
