import { App, TFile, TFolder, normalizePath } from "obsidian";
import { isAudioFileExtension } from "../constants/fileTypes";
import type { SystemSculptSettings } from "../types";

export type VaultCleanupKind = "empty" | "chat" | "extraction" | "recording";

interface CleanupItem {
  readonly file: TFile | TFolder;
  readonly path: string;
  readonly size: number;
  readonly mtime: number;
}

export interface VaultCleanupGroup {
  readonly kind: VaultCleanupKind;
  readonly directory: string | null;
  readonly items: readonly CleanupItem[];
  readonly folders: readonly CleanupItem[];
}

export type VaultCleanupPlan = Record<VaultCleanupKind, VaultCleanupGroup>;

function cleanupDirectory(value: string): string | null {
  const raw = value.trim().replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || raw.split("/").some((part) => part === "." || part === "..")) return null;
  return normalizePath(raw).replace(/\/+$/, "") || null;
}

function withinDirectory(path: string, directory: string | null): boolean {
  return directory !== null && path.startsWith(`${directory}/`);
}

function snapshot(file: TFile | TFolder): CleanupItem {
  return { file, path: file.path, size: file instanceof TFile ? file.stat.size : 0, mtime: file instanceof TFile ? file.stat.mtime : 0 };
}

async function isEmptyFile(app: App, file: TFile): Promise<boolean> {
  if (file.stat.size === 0) return true;
  if (file.stat.size >= 1024 || !["md", "txt", "markdown"].includes(file.extension.toLowerCase())) return false;
  try {
    // Frontmatter is authored content too; only whitespace is empty.
    return !(await app.vault.read(file)).trim();
  } catch {
    return false;
  }
}

/** Captures exactly the items offered for review, including their original identity. */
export async function scanVaultCleanup(
  app: App,
  settings: Pick<SystemSculptSettings, "chatsDirectory" | "extractionsDirectory" | "recordingsDirectory">,
): Promise<VaultCleanupPlan> {
  const plan: Record<VaultCleanupKind, VaultCleanupGroup & { items: CleanupItem[]; folders: CleanupItem[] }> = {
    empty: { kind: "empty", directory: null, items: [], folders: [] },
    chat: { kind: "chat", directory: cleanupDirectory(settings.chatsDirectory), items: [], folders: [] },
    extraction: { kind: "extraction", directory: cleanupDirectory(settings.extractionsDirectory), items: [], folders: [] },
    recording: { kind: "recording", directory: cleanupDirectory(settings.recordingsDirectory), items: [], folders: [] },
  };
  const directories = [plan.chat, plan.extraction, plan.recording];
  for (const file of app.vault.getFiles()) {
    const entry = snapshot(file);
    const group = directories.find((candidate) => withinDirectory(file.path, candidate.directory));
    if (group && (group.kind !== "recording" || isAudioFileExtension(file.extension))) group.items.push(entry);
    if (await isEmptyFile(app, file)) plan.empty.items.push(entry);
  }
  for (const folder of app.vault.getAllLoadedFiles()) {
    if (!(folder instanceof TFolder) || !cleanupDirectory(folder.path)) continue;
    const entry = snapshot(folder);
    if (folder.children.length === 0) plan.empty.items.push(entry);
    for (const group of directories) {
      if (folder.path === group.directory || withinDirectory(folder.path, group.directory)) group.folders.push(entry);
    }
  }
  return plan;
}

/** Applies the reviewed snapshot; later arrivals, edits, moves and replacements survive. */
export async function applyVaultCleanup(
  app: App,
  group: VaultCleanupGroup,
): Promise<{ trashed: number; skipped: number }> {
  const unchanged = (entry: CleanupItem): boolean => entry.file.path === entry.path
    && app.vault.getAbstractFileByPath(entry.path) === entry.file
    && (!(entry.file instanceof TFile) || (entry.file.stat.size === entry.size && entry.file.stat.mtime === entry.mtime));
  let trashed = 0;
  for (const entry of [...group.items].sort((a, b) => Number(a.file instanceof TFolder) - Number(b.file instanceof TFolder) || b.path.length - a.path.length)) {
    if (!unchanged(entry)) continue;
    if (entry.file instanceof TFolder) {
      if (entry.file.children.length > 0) continue;
    } else if (group.kind === "empty") {
      if (!await isEmptyFile(app, entry.file) || !unchanged(entry)) continue;
    } else if (!withinDirectory(entry.path, group.directory)) {
      continue;
    }
    await app.fileManager.trashFile(entry.file);
    trashed++;
  }
  for (const entry of [...group.folders].sort((a, b) => b.path.length - a.path.length)) {
    if (unchanged(entry) && entry.file instanceof TFolder && entry.file.children.length === 0) {
      await app.fileManager.trashFile(entry.file);
    }
  }
  return { trashed, skipped: group.items.length - trashed };
}
