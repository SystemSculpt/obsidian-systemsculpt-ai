import { App, TFile, TFolder } from "obsidian";

/**
 * Folder-note aware path resolution shared by every agent file tool.
 *
 * The Folder Notes community plugin associates a note with a folder by storing
 * it inside the folder under the folder's own name — folder `Projects` has its
 * note at `Projects/Projects.md`. To the user the note *is* the folder, so the
 * model is handed the folder-style path `Projects.md`. A plain
 * `getAbstractFileByPath("Projects.md")` then resolves to the folder (or
 * nothing), not the note, and the operation fails with "File not found" (#154).
 *
 * This module centralises the fallback so it behaves identically across read,
 * edit, move, trash, and context tools — previously only `editFile` handled it.
 * It is intentionally dependency-free (only `obsidian` vault lookups) so it can
 * run on every platform.
 */

/**
 * Resolve a folder-style path to the real Folder Notes path when one exists.
 *
 * Resolution is conservative: it only fires when the requested path is a
 * markdown file, the sibling target is a real folder, and the candidate note
 * already exists. It never invents a path, so callers that create new files are
 * unaffected.
 *
 * @returns the resolved `Folder/Folder.md` path, or `null` when no folder note
 *   applies to the requested path.
 */
export function resolveFolderNotePath(app: App, requestedPath: string): string | null {
  if (!requestedPath.endsWith(".md")) return null;

  const withoutExt = requestedPath.slice(0, -3);
  if (!withoutExt) return null;

  const lastSlash = withoutExt.lastIndexOf("/");
  const noteName = lastSlash >= 0 ? withoutExt.slice(lastSlash + 1) : withoutExt;
  if (!noteName) return null;

  const candidatePath = `${withoutExt}/${noteName}.md`;
  if (candidatePath === requestedPath) return null;

  const folder = app.vault.getAbstractFileByPath(withoutExt);
  if (!(folder instanceof TFolder)) return null;

  const candidate = app.vault.getAbstractFileByPath(candidatePath);
  if (!(candidate instanceof TFile)) return null;

  return candidatePath;
}

/**
 * Resolve a requested path to an existing `TFile`, transparently falling back to
 * the Folder Notes layout. Returns `null` when no existing file matches (the
 * path is missing, or points at a folder with no associated folder note).
 *
 * Use this for file-only operations (read, edit). Operations that also accept
 * folders (move, trash, add-folder-to-context) should look the path up directly
 * and only use {@link resolveFolderNotePath} as a fallback.
 */
export function resolveExistingVaultFile(app: App, requestedPath: string): TFile | null {
  const direct = app.vault.getAbstractFileByPath(requestedPath);
  if (direct instanceof TFile) return direct;

  const folderNotePath = resolveFolderNotePath(app, requestedPath);
  if (!folderNotePath) return null;

  const candidate = app.vault.getAbstractFileByPath(folderNotePath);
  return candidate instanceof TFile ? candidate : null;
}
