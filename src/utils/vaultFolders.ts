import { TFolder, type App } from "obsidian";

/**
 * Create one vault folder, treating an existing folder as success.
 *
 * Obsidian's createFolder rejects with "Folder already exists." whenever the
 * path exists on disk, including when the in-memory vault tree cannot resolve
 * it: during onload before indexing settles, for dot-folders the vault never
 * indexes, for a case-only mismatch on a case-insensitive filesystem, or after
 * a concurrent create. The adapter is authoritative in each case. Any other
 * failure, including a file occupying the path, still rejects.
 */
export async function createVaultFolder(app: App, path: string): Promise<void> {
  try {
    await app.vault.createFolder(path);
  } catch (error) {
    if (await isVaultFolder(app, path)) return;
    throw error;
  }
}

/**
 * Whether a folder exists at the path, from the vault tree or, when the tree
 * cannot resolve it (see createVaultFolder), from the adapter.
 */
export async function isVaultFolder(app: App, path: string): Promise<boolean> {
  try {
    if (app.vault.getAbstractFileByPath(path) instanceof TFolder) return true;
    if (!(await app.vault.adapter.exists(path))) return false;
    return (await app.vault.adapter.stat(path))?.type === "folder";
  } catch {
    return false;
  }
}
